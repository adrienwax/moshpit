import type { ControlFeedback } from '@moshpit/core';

type Values = ControlFeedback['values'];
type BrowseReadout = { identity?: string; values: Values };
type ZoomReadout = { identity: string; factor: number };

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, Math.round(Number.isFinite(value) ? value : 0)));
const frameValue = (frame: number, max: number) => ({ text: `${frame} f`, norm: max > 0 ? frame / max : 0 });
const ordinal = (paths: readonly string[], path?: string) => {
  const index = path ? paths.indexOf(path) : -1;
  return index < 0 ? undefined : { text: `${index + 1}/${paths.length}`, norm: paths.length > 1 ? index / (paths.length - 1) : 0 };
};

/** Raw source frames; OUT is exclusive. No file paths leave this local producer. */
export function browseReadout(input: {
  folder?: string; folders: readonly string[]; paths: readonly string[];
  selection?: { path: string; frames: number; frame: number; marks?: { in: number; out: number } };
}): BrowseReadout {
  const values: Values = {};
  const folder = ordinal(input.folders, input.folder);
  if (folder) values.folder = folder;
  const s = input.selection;
  if (!s || !Number.isFinite(s.frames) || s.frames < 1) return { values };
  const frames = Math.floor(s.frames), last = frames - 1;
  const clip = ordinal(input.paths, s.path);
  if (clip) values.clip = clip;
  values.frame = frameValue(clamp(s.frame, last), last);
  if (s.marks && Number.isFinite(s.marks.in) && Number.isFinite(s.marks.out)) {
    const start = clamp(s.marks.in, last), end = clamp(s.marks.out, frames);
    if (end > start) {
      values.in = frameValue(start, last);
      values.out = frameValue(end, frames);
      values.transpose = frameValue(start, last);
    }
  }
  return { identity: `raw:${s.path}`, values };
}

/** Producer registrations are leases: an old unmount cannot erase its replacement. */
export function createControlFeedbackState() {
  let browse: { read: () => BrowseReadout } | undefined;
  let zoom: { read: () => ZoomReadout | undefined } | undefined;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach(fn => fn());
  return {
    changed,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    browse(read: () => BrowseReadout) {
      const owner = browse = { read }; changed();
      return () => { if (browse === owner) { browse = undefined; changed(); } };
    },
    zoom(read: () => ZoomReadout | undefined) {
      const owner = zoom = { read }; changed();
      return () => { if (zoom === owner) { zoom = undefined; changed(); } };
    },
    snapshot(workspace: ControlFeedback['workspace'], playhead: number, frames: number, block?: { index: number; count: number }): ControlFeedback {
      if (workspace === 'browse') {
        const source = browse?.read();
        const values = { ...source?.values };
        const view = zoom?.read();
        if (source?.identity && view?.identity === source.identity && Number.isFinite(view.factor) && view.factor >= 1) {
          values.zoom = { text: `${Number(view.factor.toFixed(1))}x` };
        }
        return { workspace, values };
      }
      if (['mosh', 'node', 'render'].includes(workspace)) {
        const values: Values = {};
        if (Number.isFinite(frames) && frames > 0) {
          const last = Math.max(0, Math.floor(frames) - 1);
          values.frame = frameValue(clamp(playhead, last), last);
        }
        if (block && Number.isInteger(block.index) && Number.isInteger(block.count) && block.index >= 0 && block.index < block.count) {
          values.block = { text: `${block.index + 1}/${block.count}`, norm: block.count > 1 ? block.index / (block.count - 1) : 0 };
        }
        return { workspace, values };
      }
      return { workspace, values: {} };
    },
  };
}

export const controlFeedback = createControlFeedbackState();

/** At most 20 sends/s, always reading the latest state on the trailing edge. */
export function createFeedbackPublisher(read: () => ControlFeedback, send: (value: ControlFeedback) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = -Infinity, previous = '', disposed = false;
  const flush = () => {
    timer = undefined;
    if (disposed) return;
    const value = read(), key = JSON.stringify(value);
    if (key === previous) return;
    previous = key; lastSent = Date.now(); send(value);
  };
  return {
    changed() {
      if (disposed || timer !== undefined) return;
      const delay = Math.max(0, 50 - (Date.now() - lastSent));
      if (!delay) flush(); else timer = setTimeout(flush, delay);
    },
    dispose() { disposed = true; if (timer !== undefined) clearTimeout(timer); timer = undefined; },
  };
}
