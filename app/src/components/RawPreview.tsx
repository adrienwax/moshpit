// Raw-file views for the Source browser (Phase C): nothing here needs an import.
//   RawFrame   the preview pane: snap while the time moves, the exact frame once it rests
//   CellThumb  a grid cell: a resting thumbnail, hover-scrub along the cell
//   ScopeStrip shared RGB parade, histogram and vectorscope of the frame a view just drew
// Every raw frame is labelled raw ≈ (approximate) — only conformed frames are EXACT.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PreviewInfo } from '@moshpit/engine';
import { previewInfoOf, rawFrame, releasePreview, stillsOf, thumbOf } from '../state/preview';
import { analyse, type ScopeData } from '../scopes/data';
import { ScopePanel, type ScopeStatus } from '../scopes/ScopePanel';
import { asError } from '../qol/qol';
import { createPlaybackPump } from '../state/rawPlayback';

const REST_MS = 140;

declare global {
  interface Window {
    /** Set by an e2e test to record every frame the raw preview draws. */
    __moshpitRawDraws?: { time: number; exact: boolean; still?: boolean }[];
  }
}

function drawBitmap(c: HTMLCanvasElement, img: CanvasImageSource & { width: number; height: number }) {
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
}
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = fail;
    i.src = url;
  });
}

function useInfo(path: string) {
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setInfo(null);
    setErr(null);
    previewInfoOf(path).then((i) => live && setInfo(i), (e) => live && setErr(asError(e).humanMessage));
    return () => void (live = false);
  }, [path]);
  return { info, err };
}

/**
 * The preview pane's raw view of `path` at `timeSec`. `frameSec` (one frame of the file) marks a
 * move of a frame or less as a step: it goes straight to the exact frame. The keyframe snap first
 * flashed a different frame on every `,` / `.` before the exact one settled (Waxy, 2026-10-08).
 */
export function RawFrame({ path, timeSec, frameSec = 0, playbackRate = 0, maxW = 960, className = '', onFrame, onError }: { path: string; timeSec: number; frameSec?: number; playbackRate?: number; maxW?: number; className?: string; onFrame?: (c: HTMLCanvasElement) => void; onError?: (message: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const seq = useRef(0);
  const prev = useRef<{ path: string; t: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [meta, setMeta] = useState<{ time: number; exact: boolean; still?: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { info, err: infoErr } = useInfo(path);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  const frameCallback = useRef(onFrame); frameCallback.current = onFrame;
  const clock = useRef(timeSec); clock.current = timeSec;
  const pump = useRef<ReturnType<typeof createPlaybackPump> | null>(null);
  const continuous = !!playbackRate && info?.mode === 'native';
  useEffect(() => { if (infoErr) errorCallback.current?.(infoErr); }, [infoErr]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!continuous || !c || !info || width < 4) return;
    const w = Math.min(maxW, Math.round(width * devicePixelRatio));
    const size = { w, h: Math.round((w * info.height) / Math.max(1, info.width)) };
    const player = createPlaybackPump(
      time => rawFrame(path, time, { exact: true, playback: playbackRate > 0, size }),
      frame => {
        drawBitmap(c, frame.image);
        const m = { time: frame.time, exact: true };
        window.__moshpitRawDraws?.push(m);
        setMeta(m); setErr(null); frameCallback.current?.(c);
      },
      error => { const message = asError(error).humanMessage; setErr(message); errorCallback.current?.(message); },
      Math.sign(playbackRate),
    );
    pump.current = player;
    player.request(clock.current);
    return () => { player.stop(); if (pump.current === player) pump.current = null; };
  }, [continuous, path, width, info, maxW, playbackRate]);
  useEffect(() => { if (continuous) pump.current?.request(timeSec); }, [continuous, timeSec]);

  useEffect(() => {
    const c = ref.current;
    // Remember the moving clock too: pausing must request its exact frame immediately,
    // not flash an earlier keyframe before the 140 ms scrub-settle timer.
    if (continuous) { prev.current = { path, t: timeSec }; return; }
    if (!c || !info || width < 4) return;
    const my = ++seq.current;
    const w = Math.min(maxW, Math.round(width * devicePixelRatio));
    const size = { w, h: Math.round((w * info.height) / Math.max(1, info.width)) };
    const show = (img: CanvasImageSource & { width: number; height: number }, m: NonNullable<typeof meta>) => {
      if (my !== seq.current) return;
      drawBitmap(c, img);
      window.__moshpitRawDraws?.push(m); // e2e: every frame the pane drew, in order
      setMeta(m);
      setErr(null);
      onFrame?.(c);
    };
    const fail = (e: unknown) => {
      if (my !== seq.current) return;
      const message = asError(e).humanMessage;
      setErr(message); errorCallback.current?.(message);
    };
    if (info.mode === 'filmstrip') {
      stillsOf(path).then(async (s) => {
        const near = s.cells.reduce((a, b) => (Math.abs(b.time - timeSec) < Math.abs(a.time - timeSec) ? b : a));
        show(await loadImage(near.url), { time: near.time, exact: false, still: true });
      }).catch(fail);
      return () => { seq.current++; };
    }
    const exact = () => rawFrame(path, timeSec, { exact: true, size }).then((f) => f && (show(f.image, { time: f.time, exact: true }), f.image.close()), fail);
    const was = prev.current;
    prev.current = { path, t: timeSec };
    if (frameSec > 0 && was?.path === path && Math.abs(timeSec - was.t) <= frameSec * 1.5) {
      void exact();
      return () => { seq.current++; };
    }
    // Moving: the keyframe snap now; at rest, the exact frame.
    rawFrame(path, timeSec, { size }).then((f) => f && (show(f.image, { time: f.time, exact: false }), f.image.close()), fail);
    const t = setTimeout(exact, REST_MS);
    return () => { seq.current++; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, timeSec, width, info, maxW, continuous]);

  const why = infoErr ?? err;
  return (
    <div className={'frameview raw ' + className}>
      <canvas ref={ref} aria-label="raw preview" />
      {why ? (
        <div className="frameerr"><span>⚠</span> {why}</div>
      ) : meta && info ? (
        <>
          <span className="fx rawbadge" title={meta.still ? `${info.codec} has no live decoder here: the nearest of 12 stills from ffmpeg. Import to scrub frame-accurately.` : meta.exact ? 'The exact frame at this time, decoded straight from the file (not imported: colours and timing are approximate until conformed)' : 'The keyframe at or before this time (the pointer is moving); the exact frame follows when it rests'}>
            raw ≈ {meta.still ? 'still' : meta.exact ? 'exact frame' : 'keyframe'} · {meta.time.toFixed(2)} s{Math.abs(meta.time - timeSec) > Math.max(frameSec, 0.001) && ` · requested ${timeSec.toFixed(2)} s`}
          </span>
          <span className="fn">{info.codec} · {info.container}</span>
        </>
      ) : null}
    </div>
  );
}

/** A grid cell's picture: a resting thumbnail; move the pointer along the cell to scrub the file. */
export function CellThumb({ path, durationSec }: { path: string; durationSec: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rest, setRest] = useState<string | null>(null);
  const [frac, setFrac] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    setReady(false);
    thumbOf(path).then((t) => {
      if (!live || !t) return;
      if (typeof t === 'string') return setRest(t);
      const c = canvas.current;
      if (c) (drawBitmap(c, t), setReady(true));
    });
    return () => void (live = false);
  }, [path]);

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    setFrac(f);
    const my = ++seq.current;
    previewInfoOf(path).then(async (info) => {
      const t = f * (info.durationSec || durationSec);
      const c = canvas.current;
      if (!c) return;
      if (info.mode === 'filmstrip') {
        const s = await stillsOf(path);
        const near = s.cells.reduce((a, b) => (Math.abs(b.time - t) < Math.abs(a.time - t) ? b : a));
        if (my === seq.current) drawBitmap(c, await loadImage(near.url));
      } else {
        const fr = await rawFrame(path, t, { size: { w: 320, h: 320 }, background: true });
        if (fr && my === seq.current) drawBitmap(c, fr.image);
        fr?.image.close();
      }
      if (my === seq.current) setReady(true);
    }, () => {});
  };
  const leave = () => {
    seq.current++;
    setFrac(null);
    releasePreview(path);
    // Back to the resting picture.
    thumbOf(path).then((t) => {
      const c = canvas.current;
      if (c && t && typeof t !== 'string') drawBitmap(c, t);
    });
  };

  return (
    <div className="cellthumb" onPointerMove={move} onPointerLeave={leave}>
      {rest && !ready && <img src={rest} alt="" draggable={false} />}
      <canvas ref={canvas} className={ready ? '' : 'hidden'} />
      {frac != null && <span className="cellscrub" style={{ left: `${frac * 100}%` }} />}
    </div>
  );
}

/** Same scope layout as MOSH, using the pixels of the drawn IN frame. */
export function ScopeStrip({ data, sourceLabel = 'Source', status, detail }: {
  data: ScopeData | null; sourceLabel?: string; status?: ScopeStatus; detail?: string;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { setHost(document.getElementById('source-scope-host')); }, []);
  return host ? createPortal(<ScopePanel presentation="strip" data={data} sourceLabel={`IN · ${sourceLabel}`} status={status ?? (data ? 'measured' : 'waiting')} detail={detail ?? 'Drawn source frame · display RGB'} />, host) : null;
}

/** Measure a canvas for ScopeStrip (small copy, so a 1080p frame costs little). */
export function measure(c: HTMLCanvasElement): ScopeData {
  const scale = Math.min(1, 320 / Math.max(1, c.width), 180 / Math.max(1, c.height));
  const w = Math.max(1, Math.round(c.width * scale)), h = Math.max(1, Math.round(c.height * scale));
  const o = new OffscreenCanvas(w, h);
  const ctx = o.getContext('2d')!;
  ctx.drawImage(c, 0, 0, w, h);
  return analyse(ctx.getImageData(0, 0, w, h));
}
