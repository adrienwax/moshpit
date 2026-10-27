import { useEffect, useMemo, useRef, useState } from 'react';
import { engine, type FrameResult, type FrameTarget } from '../engine';
import { uiStore, useSettings } from '../state/ui';
import { countDropped } from '../state/telemetry';
import { Loading, asError } from '../qol/qol';
import { getDoc, useProject } from '../state/project';
import { progressivePreview } from './progressivePreview';
import { previewTiming } from '../lib/previewTiming';

type Meta = Pick<FrameResult, 'state' | 'route' | 'freeze'>;

/**
 * Audit B5: a clip's own frames (kind 'source') do not depend on the edit, so they are kept for the
 * session — loupes, strips and thumbnails come back instantly when a workspace remounts. The key
 * carries the conform's stage, so a master landing (proxy → ready) fetches the exact frame once.
 * Output and node frames depend on the document and are always asked for. ponytail: a 240-entry
 * LRU of small bitmaps (thumbs, strips); size it by bytes if big previews start to dominate.
 */
const CACHE_MAX = 240;
const cache = new Map<string, { image: ImageBitmap; meta: Meta }>();
function cacheKey(target: FrameTarget, w: number, h: number, quality: 'auto' | 'full'): string | null {
  if (target.kind !== 'source') return null;
  const d = getDoc();
  const src = d.resources.sources.find((s) => s.id === target.sourceId);
  const stage = d.resources.conforms.find((c) => c.id === src?.conformId)?.status ?? 'ready';
  return `${target.sourceId}|${stage}|${target.frame}|${w}x${h}|${quality}`;
}
function remember(key: string, image: ImageBitmap, meta: Meta) {
  cache.set(key, { image, meta });
  while (cache.size > CACHE_MAX) {
    const [oldest, v] = cache.entries().next().value!;
    cache.delete(oldest);
    v.image.close();
  }
}

/**
 * Draws whatever the engine returns for `target`, latest request wins. The badges are honest:
 * a PROXY frame says ≈, a frozen one says so, and an error shows the structured message.
 */
export function FrameView({
  target,
  maxW = 640,
  className = '',
  badges = true,
  label,
  onFrame,
  onError,
  quality = 'auto',
  onState,
  progressive = false,
  priority = 'foreground',
}: {
  target: FrameTarget | null;
  /** Cap on requested width (px); thumbnails ask for less. */
  maxW?: number;
  className?: string;
  badges?: boolean;
  /** Extra text in the top-left badge. */
  label?: string;
  /** Called with each drawn frame's canvas (scopes read pixels from it). */
  onFrame?: (c: HTMLCanvasElement) => void;
  /** Only the current request can fail its associated measurement. */
  onError?: (message: string) => void;
  quality?: 'auto' | 'full';
  /** The visible Program owns its quality indicator; scope probes must not overwrite it. */
  onState?: (state: FrameResult['state'] | undefined) => void;
  /** Program Auto draws an interactive frame, then refines once the target settles. */
  progressive?: boolean;
  /** Decorative posters/strips yield to the active viewer without changing its quality. */
  priority?: 'foreground' | 'background';
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const seq = useRef(0);
  const [meta, setMeta] = useState<Pick<FrameResult, 'state' | 'route' | 'freeze'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const stateCallback = useRef(onState);
  stateCallback.current = onState;
  const reportsState = !!onState;
  const approxOn = useSettings((s) => s.approxLabels);
  const working = useProject(d => d.settings.working);
  const key = target ? JSON.stringify(target) : '';
  // An output or node frame depends on the whole edit (blocks, graphs, params): refetch on any
  // change. It used to keep "The timeline has no blocks." after blocks were added.
  // Phase 0.1a: only what changes pixels. Selecting a node or block (doc.view) used to refetch the
  // Program frame too, a full render in the worker for nothing.
  const live = !!target && target.kind !== 'source';
  const tl = useProject((d) => (live ? d.timeline : null));
  const res = useProject((d) => (live ? d.resources : null));
  const set = useProject((d) => (live ? d.settings : null));
  const mods = useProject((d) => (live ? d.modulators : null));
  const frz = useProject((d) => (live ? d.freezes : null));
  const projectId = useProject((d) => (live ? d.id : null));
  const components = useProject((d) => (live ? d.components : null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const doc = useMemo(() => (live ? {} : null), [live, tl, res, set, mods, frz, projectId, components]);
  // P1-C (audit): during playback an output/node frame is THROTTLED, one in flight; frames the
  // playhead passes meanwhile are skipped (counted as drops for the output) and the landing frame
  // re-asks for the latest. Every tick used to start a full render, starving the worker.
  const busy = useRef(false);
  const workerEpoch = useRef(0);
  const [kick, setKick] = useState(0);
  // A paused Auto draft is showing and its exact frame is still rendering (seconds on a moshed seek).
  const [refining, setRefining] = useState(false);
  const latest = useRef('');
  latest.current = key;
  const latestDoc = useRef(doc);
  latestDoc.current = doc;
  const latestQuality = useRef(quality);
  latestQuality.current = quality;
  const sizeKey = `${width}|${maxW}|${working?.w}|${working?.h}`;
  const latestSize = useRef(sizeKey);
  latestSize.current = sizeKey;
  const active = useRef<AbortController | null>(null);
  const activeSignature = useRef<{ doc: unknown; size: string; quality: string } | null>(null);
  const refined = useRef<{ target: string; doc: unknown; size: string } | null>(null);

  // Declared before the frame effect so progressive requests are cancelled on unmount,
  // including playback requests whose latest effect was a throttled no-op.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort(); active.current = null;
      stateCallback.current?.(undefined);
    };
  }, []);

  // Paused viewers otherwise keep their failed frame until another input changes.
  // A replacement worker has already received the project before this notification.
  useEffect(() => engine.onRestart?.(() => {
    active.current?.abort(); active.current = null;
    refined.current = null;
    setRefining(false);
    workerEpoch.current++;
    busy.current = false;
    setKick(k => k + 1);
  }), []);

  // A stopped playhead may not change frame number. Re-arm refinement on pause;
  // entering playback cancels any expensive full-quality refinement immediately.
  useEffect(() => {
    if (!progressive) return;
    let playing = uiStore.get().playing;
    return uiStore.subscribe(() => {
      const next = uiStore.get().playing;
      if (next === playing) return;
      playing = next;
      if (next) setRefining(false);
      active.current?.abort(); active.current = null;
      busy.current = false;
      setKick(k => k + 1);
    });
  }, [progressive]);

  useEffect(() => { if (!target) { setRefining(false); stateCallback.current?.(undefined); } }, [key]);
  // A second Program can inherit ownership while paused, without needing another render.
  useEffect(() => { if (reportsState) stateCallback.current?.(error ? undefined : meta?.state); }, [reportsState, meta, error]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c || !target || width < 4) return;
    const my = ++seq.current;
    const epoch = workerEpoch.current;
    const w = Math.min(maxW, Math.round(width * devicePixelRatio));
    const h = Math.round(w * (working ? working.h / working.w : 9 / 16));
    const draw = (image: ImageBitmap, meta: Meta) => {
      c.width = image.width;
      c.height = image.height;
      c.getContext('2d')!.drawImage(image, 0, 0);
      setMeta(meta);
      setError(null);
      stateCallback.current?.(meta.state);
      onFrame?.(c);
    };
    const key = cacheKey(target, w, h, quality);
    const hit = key ? cache.get(key) : undefined;
    if (hit) {
      cache.delete(key!);
      cache.set(key!, hit); // most recently used
      return draw(hit.image, hit.meta);
    }
    const throttle = priority !== 'background' && target.kind !== 'source' && uiStore.get().playing;
    // A playback tick may have installed a throttled effect with no cleanup. Retain
    // the active request identity separately so a later edit still preempts it.
    if (progressive && active.current && (activeSignature.current?.doc !== doc || activeSignature.current?.size !== sizeKey || activeSignature.current?.quality !== quality)) {
      active.current.abort(); active.current = null; busy.current = false;
    }
    if (throttle && busy.current) {
      if (target.kind === 'output') { countDropped(); if (progressive) previewTiming({ ev: 'program.drop', frame: 'frame' in target ? target.frame : undefined }); }
      return; // the frame in flight re-asks for the latest when it lands
    }
    const asked = latest.current, askedDoc = doc, askedSize = sizeKey, askedAt = performance.now();
    if (throttle) busy.current = true;
    const ac = new AbortController();
    if (progressive || priority === 'background') { active.current = ac; activeSignature.current = { doc, size: sizeKey, quality }; }
    const present = (r: FrameResult, stage?: 'draft' | 'full'): boolean => {
        if (epoch !== workerEpoch.current || (progressive && (ac.signal.aborted || latestDoc.current !== askedDoc || latestSize.current !== askedSize))) { r.image.close(); return false; }
        const meta: Meta = { state: r.state, route: r.route, freeze: r.freeze };
        if (key) remember(key, r.image, meta);
        if (!mounted.current || latestQuality.current !== quality) { if (!key) r.image.close(); return false; }
        // Playing, a landed frame draws even though the playhead has moved on: it is the newest one
        // there is, possibly stale, and the landing re-asks (setKick) for the latest. Paused, it still
        // draws when it IS the current target (the playhead came back to it), or nothing would.
        const current = latest.current === asked && latestDoc.current === askedDoc;
        if (my !== seq.current && !(throttle && (uiStore.get().playing || current))) { if (!key) r.image.close(); return false; }
        draw(r.image, meta);
        if (progressive) previewTiming({ ev: 'program.draw', stage: stage ?? 'single', state: r.state, frame: 'frame' in target ? target.frame : undefined, w, playing: throttle, ms: Math.round(performance.now() - askedAt) });
        if (progressive) setRefining(stage === 'draft' && r.state === 'PROXY' && !throttle && quality === 'auto');
        if (progressive) refined.current = stage === 'full' || r.state === 'EXACT' ? { target: asked, doc: askedDoc, size: askedSize } : null;
        if (!key) r.image.close();
        return true;
    };
    const fail = (e: unknown) => {
        if (progressive && ac.signal.aborted) return;
        if (!mounted.current || my !== seq.current || epoch !== workerEpoch.current) return;
        const message = asError(e).humanMessage;
        setRefining(false);
        setError(message);
        stateCallback.current?.(undefined);
        onError?.(message);
    };
    const current = () => mounted.current && epoch === workerEpoch.current && my === seq.current && latest.current === asked && latestDoc.current === askedDoc && latestSize.current === askedSize && latestQuality.current === quality && !uiStore.get().playing;
    const fullAlreadyShown = refined.current?.target === asked && refined.current.doc === askedDoc && refined.current.size === askedSize;
    const request = progressive
      ? progressivePreview({
        signal: ac.signal, playing: throttle, fullOnly: quality === 'full' || (!throttle && fullAlreadyShown),
        request: stage => engine.frame(target, stage === 'draft' ? { w, h, quality: 'auto', interactive: true, priority, ...(throttle ? { playback: true } : {}) } : { w, h, quality: 'full', priority }, ac.signal),
        present, current, onRefineError: () => setRefining(false),
      }).catch(fail)
      : engine.frame(target, { w, h, quality, priority }, ac.signal).then(r => { present(r); }, fail);
    request.finally(() => {
      if (progressive && active.current !== ac) return;
      if (!throttle || epoch !== workerEpoch.current) return;
      busy.current = false;
      if (mounted.current && (latest.current !== asked || latestQuality.current !== quality || latestDoc.current !== askedDoc || latestSize.current !== askedSize)) setKick((k) => k + 1);
    });
    // A new target (scrub, zoom, remount) supersedes this one: let the worker skip it if still queued.
    // A throttled playback frame is not superseded: it is the one in flight.
    return () => {
      seq.current++;
      if (progressive) {
        // Keep the single in-flight playback draft across ordinary playhead ticks.
        // Every other superseding input, and unmount, cancels both stages.
        const samePlayback = throttle && mounted.current && uiStore.get().playing && latestDoc.current === askedDoc && latestQuality.current === quality && latestSize.current === askedSize;
        if (!samePlayback) {
          ac.abort();
          if (active.current === ac) { active.current = null; busy.current = false; }
        }
      } else if (priority === 'background' || (mounted.current && !throttle)) ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, width, maxW, doc, kick, quality, working, progressive, priority]);

  const frameNo = target && 'frame' in target ? target.frame : undefined;
  return (
    <div className={'frameview ' + className}>
      <canvas ref={ref} aria-label={label ?? 'frame'} />
      {badges && meta && !error && (
        <span className="fx" title={`${meta.route}. ${meta.state === 'PROXY' ? 'Preview uses reduced resolution or an approximate operation. Full selects the working-size master; captured previews and exports use the render path.' : 'Exact preview frame, fitted to this viewer.'}`}>
          {meta.state === 'PROXY' && approxOn && <span className="approx">≈ </span>}
          {label ? label + ' · ' : ''}
          {meta.route}
        </span>
      )}
      {badges && meta?.freeze && <span className={'frzflag2 ' + meta.freeze}>❄ {meta.freeze === 'stale' ? 'stale freeze' : 'frozen'}</span>}
      {badges && refining && !error && <span className="refining" role="status" title="Showing a fast draft; the exact frame replaces it when it finishes rendering."><i aria-hidden="true" />refining…</span>}
      {badges && frameNo !== undefined && <span className="fn">f {String(frameNo).padStart(5, '0')}</span>}
      {/* Phase 0.6: a big view says it is working until its first frame lands (a blank canvas read as broken). */}
      {target && !meta && !error && maxW > 200 && <div className="framewait"><Loading delay={300}>Rendering the first frame…</Loading></div>}
      {error && (
        <div className="frameerr" role="alert">
          <span>⚠</span> {error}
        </div>
      )}
    </div>
  );
}
