import type { FrameResult } from '../engine';

/** Cancellation-aware quiet period; no timer survives a superseding viewer request. */
function quiet(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('superseded', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One sequential draft/refinement operation. Presentation decides whether a result is current. */
export async function progressivePreview(options: {
  signal: AbortSignal;
  playing: boolean;
  fullOnly: boolean;
  request: (stage: 'draft' | 'full') => Promise<FrameResult>;
  present: (frame: FrameResult, stage: 'draft' | 'full') => boolean;
  current: () => boolean;
  /** A failed refinement leaves the already drawn draft and its honest metadata intact. */
  onRefineError?: (error: unknown) => void;
}): Promise<void> {
  const { signal, request, present, current } = options;
  const started = performance.now();
  if (options.fullOnly) {
    present(await request('full'), 'full');
    return;
  }
  const draft = await request('draft');
  const exact = draft.state === 'EXACT';
  if (!present(draft, 'draft') || options.playing || exact || signal.aborted) return;
  try {
    await quiet(300 - (performance.now() - started), signal);
    if (signal.aborted || !current()) return;
    present(await request('full'), 'full');
  } catch (error) {
    if (!signal.aborted && current()) options.onRefineError?.(error);
  }
}
