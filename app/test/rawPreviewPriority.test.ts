import { expect, it, vi } from 'vitest';
import { PreviewSource } from '../../engine/src/preview/source';
const state = vi.hoisted(() => { vi.stubGlobal('window', {}); return { source: null as any }; });
vi.mock('../src/engine', () => ({ engine: { previewFrame: (_path: string, time: number, req: any) => state.source.frame(time, req), closePreview: vi.fn() } }));
import { pinPreview, rawFrame } from '../src/state/preview';

it('a pinned main exact seek survives a later same-file thumbnail while decode is deferred', async () => {
  const Ctor = PreviewSource as unknown as new (...args: any[]) => PreviewSource;
  const source = new Ctor('card.mp4', {}, {}, {}, {}, {}, { w: 64, h: 36 }, 10);
  state.source = source;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(source as any, 'decode').mockImplementation(async (time: any) => { if (time === 0) await gate; return { time }; });
  const size = { w: 64, h: 36 };
  pinPreview('card.mp4');
  const busy = rawFrame('card.mp4', 0, { exact: true, size });
  await Promise.resolve();
  const main = rawFrame('card.mp4', 7, { exact: true, size });
  const thumbnail = rawFrame('card.mp4', 3, { size, background: true });
  release(); await busy;
  expect(await main).toMatchObject({ time: 7 });
  expect(await thumbnail).toBeNull();
  pinPreview();
});
