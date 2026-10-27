import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newBlock, newProject } from '../../engine/src/project/build';
import type { SourceId } from '@moshpit/engine';

const mocks = vi.hoisted(() => ({ getDoc: vi.fn(), readSticky: vi.fn(), addJob: vi.fn(), toast: vi.fn(), toastError: vi.fn() }));
vi.mock('../src/state/render', () => ({ addJob: mocks.addJob, renderStore: { get: () => [] } }));
vi.mock('../src/state/project', () => ({ getDoc: mocks.getDoc, activeBlock: () => undefined }));
vi.mock('../src/state/ui', () => ({ settingsStore: { get: () => ({ paths: { cache: 'C:/cache' } }) } }));
vi.mock('../src/state/store', async original => ({ ...await original<typeof import('../src/state/store')>(), readSticky: mocks.readSticky }));
vi.mock('../src/components/nodes', () => ({ frameRangeOf: vi.fn() }));
vi.mock('../src/qol/qol', () => ({ toast: mocks.toast, toastError: mocks.toastError }));
vi.mock('../src/host', () => ({ host: { files: { previewDir: async () => 'C:/cache/preview' } } }));
vi.mock('../src/engine', () => ({ engineKind: 'real' }));
const { previewSelection, previewSize } = await import('../src/shell/QuickRender');

beforeEach(() => {
  vi.clearAllMocks();
  const doc = newProject('short project');
  doc.timeline.blocks = [newBlock('picture', 'source' as SourceId, 0, 20)];
  mocks.getDoc.mockReturnValue(doc);
  mocks.addJob.mockResolvedValue(undefined);
});

describe('range preview after persisted arrangement zoom', () => {
  it('captures working resolution by default, with an explicit smaller option', async () => {
    mocks.readSticky.mockReturnValue(undefined);
    await previewSelection('full');
    expect(mocks.addJob.mock.calls[0][1]).toMatchObject({ width: 1920, height: 1080 });
    mocks.readSticky.mockImplementation(key => key === 'preview.resolution' ? 'fast' : undefined);
    await previewSelection('full');
    expect(mocks.addJob.mock.calls[1][1]).toMatchObject({ width: 960, height: 540 });
    expect(previewSize({ w: 1080, h: 1920 }, 'fast')).toEqual({ w: 304, h: 540 });
    expect(previewSize({ w: 640, h: 360 }, 'fast')).toEqual({ w: 640, h: 360 });
  });
  it('clamps an old zoom start beyond a shorter project to its last frame', async () => {
    mocks.readSticky.mockReturnValue({ start: 900, len: 50, of: 1000 });
    await previewSelection('range');
    expect(mocks.addJob.mock.calls[0][1].range).toEqual([19, 19]);
    expect(mocks.addJob.mock.calls[0][3].previewScope).toBe('Range f19-19');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { start: NaN, len: 5, of: 20 },
    { start: Infinity, len: 5, of: 20 },
    { start: 4, len: Infinity, of: Infinity },
    { start: 4, len: NaN, of: 20 },
    { start: 4, len: 0, of: 20 },
    { start: 4, len: -5, of: 20 },
    { start: 4, len: 5, of: NaN },
    { start: 4, len: 5, of: Infinity },
  ])('falls back to a finite full range for invalid zoom %j', async zoom => {
    mocks.readSticky.mockReturnValue(zoom);
    await previewSelection('range');
    expect(mocks.addJob.mock.calls[0][1].range).toEqual([0, 19]);
  });

  it.each([
    [{ start: 4.2, len: 5.2, of: 20 }, [4, 10]],
    [{ start: 18, len: 5, of: 20 }, [18, 19]],
    [{ start: -4, len: 5, of: 20 }, [0, 1]],
    [{ start: 8, len: 20, of: 20 }, [0, 19]],
  ])('retains valid window rounding and timeline boundaries for %j', async (zoom, expected) => {
    mocks.readSticky.mockReturnValue(zoom);
    await previewSelection('range');
    expect(mocks.addJob.mock.calls[0][1].range).toEqual(expected);
  });

  it('does not queue a preview for an empty replacement project', async () => {
    mocks.getDoc.mockReturnValue(newProject('empty'));
    mocks.readSticky.mockReturnValue({ start: 900, len: 50, of: 1000 });
    await previewSelection('range');
    expect(mocks.addJob).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalled();
  });
});
