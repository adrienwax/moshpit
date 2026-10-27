import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ mkdirSync: vi.fn(), appendFileSync: vi.fn() }));
vi.mock('node:fs', () => io);
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); vi.stubEnv('MOSHPIT_PREVIEW_TIMING', ''); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('optional preview timing diagnostics', () => {
  it('does no IO unless enabled', async () => {
    const m = await import('../src/telemetry/previewTiming'); m.previewTiming({ ev: 'frame' });
    expect(m.previewTimingOn).toBe(false); expect(io.mkdirSync).not.toHaveBeenCalled(); expect(io.appendFileSync).not.toHaveBeenCalled();
  });
  it('records one JSON line when its destination is usable', async () => {
    vi.stubEnv('MOSHPIT_PREVIEW_TIMING', 'E:/owned/probe/timing.jsonl');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = await import('../src/telemetry/previewTiming'); m.previewTiming({ ev: 'frame', frame: 12 });
    expect(m.previewTimingOn).toBe(true); expect(io.appendFileSync).toHaveBeenCalledTimes(1);
    const [file, line] = io.appendFileSync.mock.calls[0];
    expect(file).toBe('E:/owned/probe/timing.jsonl'); expect(JSON.parse(line)).toMatchObject({ ev: 'frame', frame: 12 });
    expect(line.endsWith('\n')).toBe(true);
  });
  it('disables an invalid diagnostic destination without failing worker import', async () => {
    vi.stubEnv('MOSHPIT_PREVIEW_TIMING', 'E:/owned/not-a-folder/timing.jsonl');
    io.mkdirSync.mockImplementationOnce(() => { throw new Error('EACCES'); });
    const m = await import('../src/telemetry/previewTiming');
    expect(m.previewTimingOn).toBe(false); expect(() => m.previewTiming({ ev: 'frame' })).not.toThrow();
    expect(io.appendFileSync).not.toHaveBeenCalled();
  });
  it('does not turn a later append failure into a render failure', async () => {
    vi.stubEnv('MOSHPIT_PREVIEW_TIMING', 'E:/owned/probe/timing.jsonl');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = await import('../src/telemetry/previewTiming');
    io.appendFileSync.mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    expect(() => m.previewTiming({ ev: 'frame' })).not.toThrow();
  });
});
