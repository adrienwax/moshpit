import { afterEach, describe, expect, it, vi } from 'vitest';
import { browseFrame, createBrowseCommands, dispatchBrowseCommand, registerBrowseControls, registerBrowseTransport, selectBrowseClip } from '../src/state/browseControl';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

function fixture() {
  const paths = ['A', 'B', 'C'];
  let selected = 'A';
  const frames: Record<string, number> = { A: 36, B: 57, C: 12 };
  const stop = vi.fn(), events: string[] = [], marks = vi.fn();
  const select = (path: string) => selectBrowseClip(path, {
    current: () => selected,
    stop: () => { events.push('stop'); stop(); },
    reset: path => { events.push(`reset:${path}`); frames[path] = 0; },
    select: path => { events.push(`select:${path}`); selected = path; },
  });
  const handler = createBrowseCommands({
    selection: () => ({ path: selected, frames: 100, fps: selected === 'B' ? 30000 / 1001 : 24, frame: frames[selected], marks: { in: 20, out: 80 }, usable: true }),
    paths: () => paths, select, seek: (path, frame) => { frames[path] = frame; }, marks, send: vi.fn(), notice: vi.fn(),
  });
  cleanup.push(registerBrowseControls(handler));
  return { frames, events, selected: () => selected, marks, stop };
}

describe('IN clip landing and same-batch CT frame steps', () => {
  it('opens unseen clips on zero rather than 40 percent and clamps restored invalid positions', () => {
    expect(browseFrame(undefined, 360)).toBe(0);
    expect(browseFrame(NaN, 360)).toBe(0);
    expect(browseFrame(480, 360)).toBe(359);
    expect(browseFrame(-1, 360)).toBe(0);
  });
  it('stops the old shuttle and resets before publishing the next selection without changing marks', () => {
    const f = fixture();
    dispatchBrowseCommand('clip.next');
    expect(f.selected()).toBe('B'); expect(f.frames.B).toBe(0);
    expect(f.events).toEqual(['stop', 'reset:B', 'select:B']);
    expect(f.marks).not.toHaveBeenCalled();
    dispatchBrowseCommand('clip.prev'); expect(f.frames.A).toBe(0);
  });
  it('applies every detent to the new live selection while the old React track still owns transport', () => {
    const f = fixture(), staleTrack = vi.fn(() => false);
    cleanup.push(registerBrowseTransport(staleTrack));
    dispatchBrowseCommand('clip.next');
    dispatchBrowseCommand('transport.nextFrame'); dispatchBrowseCommand('transport.nextFrame');
    expect(f.frames.B).toBe(2); expect(f.frames.A).toBe(36);
    expect(staleTrack.mock.calls).toEqual([['transport.stop'], ['transport.stop']]);
    dispatchBrowseCommand('transport.prevFrame'); expect(f.frames.B).toBe(1);
    dispatchBrowseCommand('clip.next'); expect(f.frames.C).toBe(0);
    dispatchBrowseCommand('transport.prevFrame'); expect(f.frames.C).toBe(0);
  });
  it('uses new source fps for one batched coarse seek before its React track mounts', () => {
    const f = fixture(), staleTrack = vi.fn(() => false);
    cleanup.push(registerBrowseTransport(staleTrack));
    dispatchBrowseCommand('clip.next');
    dispatchBrowseCommand('transport.nextFrame', { mode: 'coarse', repeat: 2 });
    expect(f.frames.B).toBe(60); expect(f.frames.A).toBe(36);
    dispatchBrowseCommand('clip.next');
    dispatchBrowseCommand('transport.nextFrame', { mode: 'coarse' });
    expect(f.frames.C).toBe(24);
    dispatchBrowseCommand('transport.nextFrame', { mode: 'coarse', repeat: 10 });
    expect(f.frames.C).toBe(99);
    dispatchBrowseCommand('transport.prevFrame', { mode: 'fine' });
    expect(f.frames.C).toBe(98);
  });
  it('does not reset or step a clip again when navigation hits either end', () => {
    const f = fixture(); dispatchBrowseCommand('clip.prev');
    expect(f.events).toEqual([]); expect(f.frames.A).toBe(36);
    dispatchBrowseCommand('clip.next'); dispatchBrowseCommand('clip.next');
    dispatchBrowseCommand('transport.nextFrame');
    dispatchBrowseCommand('clip.next'); expect(f.frames.C).toBe(1);
  });
});
