// The timeline kit (usability plan §2b — every timeline is built from it, so zooming is one reflex):
// a zoom view over the whole length, a three-tier tick ruler, a DaVinci-style zoom navigator (drag
// the window to pan, drag its edges to zoom, click outside it to jump), wheel-to-zoom on the track,
// and draggable IN/OUT handles. Units are frames throughout; a view is { start, len }.
import { beginGesture, endGesture, transact } from '../state/project';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSticky } from '../state/store';
import { transposeRange } from '../lib/sourceRange';
import { rangeDrag } from '../lib/rangeDrag';
import { getProjectSession } from '../state/jobs';
import './timelineRange.css';
import './timelineTicks.css';
import { compactRulerLabel, pickTicks, tickFrames } from '../lib/ticks';

import { clampView, MIN_LEN, type View } from '../lib/timelineView';
export { clampView, type View } from '../lib/timelineView';

/**
 * A persisted zoom view over `total` frames (B7: survives a workspace switch). When `follow` leaves
 * the view (a shuttle, a jump) the view re-centres on it.
 */
export function useZoom(key: string, total: number, follow?: number) {
  // `of` is the length the view was set against: a view that showed everything keeps showing
  // everything as the length changes (blocks added, a conform finishing), instead of ending up zoomed.
  const [raw, setRaw] = useSticky<View & { of: number }>(`zoom:${key}`, { start: 0, len: total, of: total });
  const fitted = raw.len >= raw.of || raw.len <= 0;
  const view = clampView(fitted ? { start: 0, len: total } : raw, total);
  const setView = (fn: View | ((v: View) => View)) =>
    setRaw((v) => ({ ...clampView(typeof fn === 'function' ? fn(clampView(v.len >= v.of ? { start: 0, len: total } : v, total)) : fn, total), of: total }));
  useEffect(() => {
    if (follow == null) return;
    if (follow < view.start || follow > view.start + view.len) setView((v) => ({ start: follow - v.len / 2, len: v.len }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow]);
  /** Zoom by k (<1 in) keeping `anchor` (a frame) under the same spot. */
  const zoomAt = (k: number, anchor: number) => setView((v) => ({ start: anchor - (anchor - v.start) * k, len: v.len * k }));
  const fit = () => setView({ start: 0, len: total });
  return { view, setView, zoomAt, fit, zoom: total / view.len };
}

/** Wheel over a track: zoom around the pointer; Shift+wheel (or a sideways wheel) pans. */
export function useWheelZoom(ref: React.RefObject<HTMLElement | null>, z: ReturnType<typeof useZoom>) {
  const live = useRef(z);
  live.current = z;
  // No deps: the track can mount after this hook first runs (an empty arrangement, a loupe with no
  // clip yet), so the listener is (re)attached to whatever element the ref holds after each render.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Native, non-passive: React's onWheel is passive and cannot stop the page from scrolling.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view, setView, zoomAt } = live.current;
      const r = el.getBoundingClientRect();
      const at = view.start + ((e.clientX - r.left) / r.width) * view.len;
      const pan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (pan) setView((v) => ({ start: v.start + ((e.shiftKey ? e.deltaY : e.deltaX) / r.width) * v.len, len: v.len }));
      else zoomAt(e.deltaY > 0 ? 1.25 : 0.8, at);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });
}

/** Drag with pointer capture; `fn` gets the pointer x as a frame in `view` over `el`. */
export function dragFrames(e: React.PointerEvent, el: HTMLElement, view: View, fn: (frame: number, done: boolean) => void) {
  if (e.button !== 0) return;
  e.stopPropagation();
  el.setPointerCapture(e.pointerId);
  const r = el.getBoundingClientRect();
  const at = (x: number) => view.start + ((x - r.left) / r.width) * view.len;
  beginGesture(); // a dragged IN / OUT handle is one undo step, however long the drag
  fn(at(e.clientX), false);
  const move = (ev: PointerEvent) => fn(at(ev.clientX), false);
  const up = (ev: PointerEvent) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    fn(at(ev.clientX), true);
    endGesture();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * The tick ruler: major (with a label), minor and fine marks for `view`, from `steps` (frames).
 * `label` turns a major tick's frame into its text (timecode, or a bar number); it gets the major
 * step too, so a sub-second step can keep its frames.
 */
export function Ticks({ view, steps, label, className = '' }: { view: View; steps: number[]; label: (f: number, majorStep: number) => string; className?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const t = pickTicks(view.len, Math.max(1, w), steps);
  const x = (f: number) => ((f - view.start) / view.len) * 100 + '%';
  const majors = new Set(tickFrames(t.major, view.start, view.len).map(Math.round));
  const minors = tickFrames(t.minor, view.start, view.len).map(Math.round).filter((f) => !majors.has(f));
  const minorSet = new Set(minors);
  const fines = tickFrames(t.fine, view.start, view.len).map(Math.round).filter((f) => !majors.has(f) && !minorSet.has(f));
  return (
    <div ref={ref} className={'ticks ' + className} aria-hidden data-major={t.major} data-minor={t.minor} data-fine={t.fine}>
      {w > 0 && fines.map((f) => <i key={'f' + f} className="tk fine" style={{ left: x(f) }} />)}
      {w > 0 && minors.map((f) => <i key={'m' + f} className="tk minor" style={{ left: x(f) }} />)}
      {w > 0 && [...majors].map((f) => <i key={'M' + f} className="tk major" style={{ left: x(f) }}><span>{label(f, t.major)}</span></i>)}
    </div>
  );
}

/**
 * The zoom navigator under a track: the whole length, with the visible window as a bar. Drag the
 * bar to pan, drag either edge to zoom, click outside the bar to centre the window there.
 * `children` are overlays positioned in whole-length %, e.g. the IN–OUT region.
 */
export function ZoomNav({ total, z, children, title = 'Zoom navigator: drag the window to pan, its edges to zoom, click to jump' }: { total: number; z: ReturnType<typeof useZoom>; children?: React.ReactNode; title?: string }) {
  const { view, setView } = z;
  const pc = (f: number) => (f / Math.max(1, total)) * 100 + '%';
  const grab = (e: React.PointerEvent, mode: 'pan' | 'l' | 'r' | 'jump') => {
    const nav = (e.currentTarget as HTMLElement).closest('.zoomnav') as HTMLElement;
    const v0 = view;
    const r = nav.getBoundingClientRect();
    const sx = e.clientX;
    const toF = (dx: number) => (dx / r.width) * total;
    if (mode === 'jump') setView({ start: ((e.clientX - r.left) / r.width) * total - v0.len / 2, len: v0.len });
    e.stopPropagation();
    nav.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = toF(ev.clientX - sx);
      if (mode === 'pan' || mode === 'jump') setView({ start: (mode === 'jump' ? ((sx - r.left) / r.width) * total - v0.len / 2 : v0.start) + d, len: v0.len });
      else if (mode === 'l') setView({ start: Math.min(v0.start + d, v0.start + v0.len - MIN_LEN), len: v0.len - Math.min(d, v0.len - MIN_LEN) });
      else setView({ start: v0.start, len: Math.max(MIN_LEN, v0.len + d) });
    };
    const up = () => (nav.removeEventListener('pointermove', move), nav.removeEventListener('pointerup', up));
    nav.addEventListener('pointermove', move);
    nav.addEventListener('pointerup', up);
  };
  return (
    <div className="zoomnav" onPointerDown={(e) => grab(e, 'jump')} title={title} role="scrollbar" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(view.start)}>
      {children}
      <div className="znwin" style={{ left: pc(view.start), width: pc(view.len) }} onPointerDown={(e) => grab(e, 'pan')}>
        <span className="znh l" onPointerDown={(e) => grab(e, 'l')} title="Drag to zoom (left edge)" />
        <span className="znh r" onPointerDown={(e) => grab(e, 'r')} title="Drag to zoom (right edge)" />
      </div>
    </div>
  );
}

/** Timecode for a ruler: whole seconds when the labelled step is a second or more, else with frames. */
export const rulerTime = (tc: (f: number) => string, fps: number) => (f: number, step: number) => compactRulerLabel(tc(f), step < fps - 0.5);

/** −/＋/fit buttons and the zoom factor, for a timeline header. */
export function ZoomButtons({ z }: { z: ReturnType<typeof useZoom> }) {
  const mid = z.view.start + z.view.len / 2;
  return (
    <span className="zbtns">
      <button title="Zoom out (wheel down over the track)" onClick={() => z.zoomAt(1.6, mid)}>−</button>
      <button title="Zoom in (wheel up over the track)" onClick={() => z.zoomAt(1 / 1.6, mid)}>＋</button>
      <button title="Fit the whole length" onClick={z.fit}>⤢</button>
      <span className="zx">{z.zoom.toFixed(1)}×</span>
    </span>
  );
}

/**
 * IN/OUT on a track in `view`: the outside dimmed, the range banded, and both edges as handles you
 * drag (snapped by `snap`). Dragging an edge past the other is stopped one frame short.
 */
export function MarkHandles({ view, marks, setMarks, snap = (f) => Math.round(f), track, total, identity, isCurrent, projectGesture = true }: {
  view: View; marks: { in: number; out: number }; setMarks: (i: number, o: number) => void;
  snap?: (f: number) => number; track: React.RefObject<HTMLElement | null>;
  total?: number; identity?: string; isCurrent?: () => boolean; projectGesture?: boolean;
}) {
  const cancel = useRef<(() => void) | undefined>(undefined);
  const [draft, setDraft] = useState<{ identity?: string; in: number; out: number } | null>(null);
  const shown = draft && draft.identity === identity ? draft : marks;
  const liveMarks = useRef(marks); liveMarks.current = marks;
  const liveIdentity = useRef(identity); liveIdentity.current = identity;
  useEffect(() => () => { cancel.current?.(); cancel.current = undefined; }, [identity]);
  // Project marks are a preview until release. Restoring them with a second project edit would
  // erase Redo and leave a no-op Undo. Local staging also preserves unrelated edits made mid-drag.
  const markEdit = () => {
    const original = { ...marks }, initialIdentity = identity, initialSession = getProjectSession();
    let next = original;
    const current = () => liveIdentity.current === initialIdentity && (!isCurrent || isCurrent())
      && (!projectGesture || (getProjectSession() === initialSession && liveMarks.current.in === original.in && liveMarks.current.out === original.out));
    return {
      original, current,
      move: (i: number, o: number) => {
        next = { in: i, out: o };
        if (projectGesture) setDraft({ ...next, identity: initialIdentity }); else setMarks(i, o);
      },
      restore: () => { if (!projectGesture) setMarks(original.in, original.out); },
      end: (cancelled: boolean) => {
        setDraft(null);
        if (projectGesture && !cancelled && current() && (next.in !== original.in || next.out !== original.out)) {
          transact(() => setMarks(next.in, next.out));
        }
      },
    };
  };
  const transpose = (e: React.PointerEvent) => {
    if (e.button !== 0 || total == null || !track.current || (isCurrent && !isCurrent())) return;
    e.preventDefault(); e.stopPropagation();
    cancel.current?.();
    const el = track.current, width = el.getBoundingClientRect().width;
    if (width <= 0) return;
    const edit = markEdit();
    document.body.classList.add('dragging-range');
    cancel.current = rangeDrag({
      target: el, pointerId: e.pointerId, startX: e.clientX,
      current: edit.current,
      move: dx => { const next = transposeRange(edit.original, dx / width * view.len, total); edit.move(next.in, next.out); },
      restore: edit.restore,
      end: cancelled => { document.body.classList.remove('dragging-range'); edit.end(cancelled); },
    });
  };
  const rangeLeft = Math.max(0, (shown.in - view.start) / view.len * 100);
  const rangeRight = Math.min(100, (shown.out - view.start) / view.len * 100);

  const pc = (f: number) => ((f - view.start) / view.len) * 100 + '%';
  const drag = (which: 'in' | 'out') => (e: React.PointerEvent) => {
    const el = track.current;
    if (e.button !== 0 || !el || (isCurrent && !isCurrent())) return;
    e.preventDefault(); e.stopPropagation(); cancel.current?.();
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const edit = markEdit(), original = edit.original;
    const update = (dx: number) => {
      const f = snap(view.start + (e.clientX + dx - rect.left) / rect.width * view.len);
      if (which === 'in') edit.move(Math.min(f, original.out - 1), original.out);
      else edit.move(original.in, Math.max(f, original.in + 1));
    };
    document.body.classList.add('dragging-mark');
    cancel.current = rangeDrag({
      target: el, pointerId: e.pointerId, startX: e.clientX,
      current: edit.current,
      move: update, restore: edit.restore,
      end: cancelled => { document.body.classList.remove('dragging-mark'); edit.end(cancelled); },
    });
    update(0);
  };
  return (
    <>
      <div className="mkdim" style={{ left: 0, width: `max(0px, ${pc(shown.in)})` }} />
      <div className="mkdim" style={{ left: pc(shown.out), right: 0 }} />
      <div className="mkband" style={{ left: pc(shown.in), width: ((shown.out - shown.in) / view.len) * 100 + '%' }} />
      {total != null && rangeRight > rangeLeft && <button type="button" className="mkrange"
        style={{ left: `clamp(12px, ${(rangeLeft + rangeRight) / 2}%, calc(100% - 12px))`, width: `max(22px, calc(${rangeRight - rangeLeft}% - 56px))` }}
        onPointerDown={transpose} onKeyDown={e => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault(); e.stopPropagation();
          if (isCurrent && !isCurrent()) return;
          const next = transposeRange(marks, (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1), total);
          setMarks(next.in, next.out);
        }} aria-label="Move marked range" title="Move In and Out together · drag or arrow keys · Escape cancels drag"><span aria-hidden>↔</span></button>}
      <div className="mkh in" style={{ left: pc(shown.in) }} onPointerDown={drag('in')} title={`IN ${shown.in} — drag to move`} role="slider" aria-label="IN" aria-valuenow={shown.in}><span className="flag">IN</span></div>
      <div className="mkh out" style={{ left: pc(shown.out) }} onPointerDown={drag('out')} title={`OUT ${shown.out} — drag to move`} role="slider" aria-label="OUT" aria-valuenow={shown.out}><span className="flag">OUT</span></div>
    </>
  );
}
