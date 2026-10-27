// Raw-file preview, UI side (Phase C, PREVIEW-API.md). The Source browser looks at files without
// importing them: preview info and thumbnails are cached per file for the session, and this module
// owns which files hold an open preview decoder — every hover releases its file on leave, except
// the one pinned in the preview pane, so the UI never leaks decoders (the engine's 4-file LRU is
// only the backstop).
import type { PreviewInfo } from '@moshpit/engine';
import { engine } from '../engine';

const infos = new Map<string, Promise<PreviewInfo>>();
/** What a raw file is and whether it scrubs live (native) or only shows stills (filmstrip). */
export function previewInfoOf(path: string): Promise<PreviewInfo> {
  let p = infos.get(path);
  if (!p) {
    p = engine.previewInfo ? engine.previewInfo(path) : Promise.reject(new Error('no raw preview in this engine'));
    p.catch(() => infos.delete(path));
    infos.set(path, p);
  }
  return p;
}

export interface Stills { durationSec: number; cells: { time: number; url: string }[] }
const stills = new Map<string, Promise<Stills>>();
/** Evenly spaced stills (ffmpeg, cached on disk by the engine): filmstrip-only files scrub on these. */
export function stillsOf(path: string, count = 12, width = 320): Promise<Stills> {
  const key = `${path}|${count}|${width}`;
  let p = stills.get(key);
  if (!p) {
    p = engine.filmstrip!(path, { count, width }).then((s) => ({
      durationSec: s.durationSec,
      cells: s.cells.map((c) => ({ time: c.time, url: URL.createObjectURL(new Blob([c.jpeg as BlobPart], { type: 'image/jpeg' })) })),
    }));
    p.catch(() => stills.delete(key));
    stills.set(key, p);
  }
  return p;
}

// ---------- decoder lifecycle ----------

const open = new Set<string>();
let pinned: string | undefined;

/** One raw frame. Snap (keyframe) while the pointer moves, exact once it rests. Null = superseded. */
export function rawFrame(path: string, timeSec: number, req: { exact?: boolean; playback?: boolean; size: { w: number; h: number }; background?: boolean }) {
  // A poster must not supersede the selected viewer's queued exact seek.
  if (req.background && path === pinned) return Promise.resolve(null);
  const { background: _, ...request } = req;
  open.add(path);
  return engine.previewFrame!(path, Math.max(0, timeSec), request);
}

/** The pointer left a cell: free that file's decoder, unless the preview pane is showing it. */
export function releasePreview(path: string) {
  if (path === pinned || !open.delete(path)) return;
  engine.closePreview?.(path);
}

/** The preview pane shows `path` now (or nothing): the previous pinned file is released. */
export function pinPreview(path?: string) {
  const old = pinned;
  pinned = path;
  if (old && old !== path) releasePreview(old);
}

// Thumbnails: one snap per native file at 30 % in, kept as a bitmap for the session; filmstrip
// files use their first still. Two at a time, so a big folder does not flood the worker.
const thumbs = new Map<string, Promise<ImageBitmap | string | null>>();
let running = 0;
const waiting: (() => void)[] = [];
const slot = () => (running < 2 ? (running++, Promise.resolve()) : new Promise<void>((r) => waiting.push(() => (running++, r()))));
const done = () => (running--, waiting.shift()?.());

/** A cell's resting image: an ImageBitmap (native snap) or a still's object URL; null if neither. */
export function thumbOf(path: string): Promise<ImageBitmap | string | null> {
  let p = thumbs.get(path);
  if (!p) {
    p = (async () => {
      await slot();
      try {
        const info = await previewInfoOf(path);
        if (info.mode === 'filmstrip') return (await stillsOf(path)).cells[Math.floor(12 * 0.3)]?.url ?? null;
        // Null = superseded by a newer request for the same file (the preview pane showing it): ask
        // again rather than caching "no thumbnail" for the session.
        // The preview pane can re-ask for the same file several times while its layout settles,
        // so back off for up to ~15 s rather than giving up after a few tries.
        for (let i = 0; i < 20; i++) {
          const f = await rawFrame(path, info.durationSec * 0.3, { size: { w: 320, h: 320 }, background: true });
          if (f) return f.image;
          await new Promise((r) => setTimeout(r, Math.min(1000, 150 * (i + 1))));
        }
        return null;
      } catch {
        return null;
      } finally {
        releasePreview(path);
        done();
      }
    })();
    p.then((t) => t === null && thumbs.delete(path));
    thumbs.set(path, p);
  }
  return p;
}

// Test hook (preview-browser e2e): which files hold an open preview right now.
(window as { __moshpitPreview?: unknown }).__moshpitPreview = { open: () => [...open], pinned: () => pinned };
