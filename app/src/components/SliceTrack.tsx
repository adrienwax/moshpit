import { rotaryCommandAmount } from '@moshpit/core';
// The frame-accurate slice track: transport (J/K/L shuttle, , . step, I/O marks), snap
// (frame/beat/bar on the project BPM), a scrub lane with marks, chapters and the playhead.
// Used by Mosh mode's slice pane and Browse/Slice's big preview.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chapter, Rational } from '@moshpit/engine';
import { fpsValue, timecode } from '../lib/time';
import { setUi, uiStore, useUi } from '../state/ui';
import { RadialPick } from '../radial/RadialPick';
import { Icon } from './Icon';
import { PreviewTransport } from './PreviewTransport';
import { MediaMark, Timecode } from './MediaReadout';
import { MarkHandles, Ticks, ZoomButtons, ZoomNav, dragFrames, rulerTime, useWheelZoom, useZoom } from './TimelineKit';
import { timeSteps } from '../lib/ticks';
import { blocksShortcutTarget } from '../lib/keyboard';
import { registerBrowseTransport, registerBrowseViewport } from '../state/browseControl';
import { controlFeedback } from '../state/controlFeedback';

export interface SliceTrackProps {
  frames: number;
  /** Main IN viewer gets the shared transport; compact slot tracks keep their controls. */
  previewTarget?: string;
  frame: number;
  setFrame: (f: number) => void;
  marks: { in: number; out: number } | null;
  setMarks: (inF: number, outF: number) => void;
  fps: Rational;
  bpm: number;
  chapters?: Chapter[];
  tall?: boolean;
  /** Bind the transport keys while this track is on screen. */
  keys?: boolean;
  /** Route CT transport to this visible IN track. */
  browseControl?: boolean;
  extra?: React.ReactNode;
  /** Reject input from a track replaced before React has painted the next source. */
  isCurrent?: () => boolean;
  /** Raw IN preview uses sequential decoding during shuttle, exact seeks when stopped. */
  onShuttleChange?: (rate: number) => void;
  /** Keys this track's zoom view (kept per clip across workspace switches). */
  zoomKey: string;
}

export function SliceTrack({ frames, frame, setFrame, marks, setMarks, fps, bpm, chapters, tall, keys, browseControl, extra, zoomKey, isCurrent, onShuttleChange, previewTarget }: SliceTrackProps) {
  const snap = useUi((s) => s.snap);
  const lane = useRef<HTMLDivElement>(null);
  const shuttle = useRef(0);
  const [shuttleRate, showShuttleRate] = useState(0);
  const shuttleCallback = useRef(onShuttleChange); shuttleCallback.current = onShuttleChange;
  const setShuttle = (rate: number) => { if (shuttle.current !== rate) { shuttle.current = rate; showShuttleRate(rate); shuttleCallback.current?.(rate); } };
  const position = useRef(frame);
  const lastSent = useRef(frame);
  const live = useRef({ frame, frames, marks, setFrame, setMarks, isCurrent, fps });
  const z = useZoom(zoomKey, frames, frame);
  useWheelZoom(lane, z);
  const steps = useMemo(() => timeSteps(fpsValue(fps)), [fps]);
  live.current = { frame, frames, marks, setFrame, setMarks, isCurrent, fps };
  const zoomLive = useRef(z);
  zoomLive.current = z;
  useEffect(() => {
    if (!browseControl) return;
    return controlFeedback.zoom(() => live.current.isCurrent?.() === false ? undefined : { identity: zoomKey, factor: zoomLive.current.zoom });
  }, [browseControl, zoomKey]);
  useEffect(() => { if (browseControl) controlFeedback.changed(); }, [browseControl, zoomKey, z.zoom]);

  const beatF = (fpsValue(fps) * 60) / bpm;
  const unit = snap === 'beat' ? beatF : snap === 'bar' ? beatF * 4 : 1;
  const snapF = (f: number) => Math.max(0, Math.min(frames - 1, Math.round(Math.round(f / unit) * unit)));
  const clampF = (f: number) => Math.max(0, Math.min(frames - 1, Math.round(f)));

  // J/K/L shuttle runs on rAF; repeated L/J doubles the speed, K stops.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      // performance.now(), not the rAF timestamp: that can predate `last` and step backwards.
      const t = performance.now();
      const dt = Math.max(0, (t - last) / 1000);
      last = t;
      if (shuttle.current) {
        const { frame: f, frames: n, setFrame: sf } = live.current;
        if (Math.round(f) !== Math.round(lastSent.current)) position.current = f;
        const next = position.current + shuttle.current * fpsValue(fps) * dt;
        position.current = Math.max(0, Math.min(n - 1, next));
        lastSent.current = Math.round(position.current);
        sf(position.current);
        if (next <= 0 || next >= n - 1) setShuttle(0);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const page = typeof document === 'undefined' ? undefined : document;
    const visibility = () => { if (page?.hidden) setShuttle(0); last = performance.now(); };
    page?.addEventListener('visibilitychange', visibility);
    return () => { cancelAnimationFrame(raf); page?.removeEventListener('visibilitychange', visibility); setShuttle(0); };
  }, [fps]);

  useEffect(() => {
    setShuttle(0);
    position.current = live.current.frame;
    lastSent.current = live.current.frame;
  }, [zoomKey]);

  useEffect(() => {
    if (!browseControl) return;
    return registerBrowseTransport((command, options) => {
      const current = live.current;
      if (current.isCurrent && !current.isCurrent()) return false;
      if (command === 'transport.prevFrame' || command === 'transport.nextFrame') {
        setShuttle(0);
        const amount = rotaryCommandAmount(command, options, fpsValue(current.fps));
        const next = Math.max(0, Math.min(current.frames - 1, Math.round(current.frame) + (command === 'transport.nextFrame' ? amount : -amount)));
        current.frame = next; // consecutive CT detents may arrive before React paints
        current.setFrame(next);
      } else if (command === 'transport.stop') setShuttle(0);
      else if (command === 'transport.play' || command === 'transport.loop') {
        position.current = current.frame; lastSent.current = current.frame;
        setShuttle(command === 'transport.loop' && shuttle.current ? 0 : 1);
      } else return false;
      return true;
    });
  }, [browseControl]);

  useEffect(() => {
    if (!browseControl) return;
    return registerBrowseViewport((command, options) => {
      const current = live.current;
      if (current.isCurrent && !current.isCurrent()) return false;
      if (command === 'source.zoomFit') zoomLive.current.fit();
      else if (command === 'source.zoomIn' || command === 'source.zoomOut') zoomLive.current.zoomAt(Math.pow(command === 'source.zoomIn' ? .8 : 1.25, rotaryCommandAmount(command, options)), current.frame);
      else return false;
      return true;
    });
  }, [browseControl]);

  const act = (k: string) => {
    const { frame: f, marks: m, setMarks: sm, setFrame: sf } = live.current;
    const cur = Math.round(f);
    if ((k === 'j' || k === 'l') && !shuttle.current) { position.current = f; lastSent.current = f; }
    if (k === 'j') setShuttle(shuttle.current < 0 ? Math.max(-8, shuttle.current * 2) : -1);
    else if (k === 'l') setShuttle(shuttle.current > 0 ? Math.min(8, shuttle.current * 2) : 1);
    else if (k === 'k') setShuttle(0);
    else if (k === ',') { setShuttle(0); sf(clampF(cur - unit)); }
    else if (k === '.') { setShuttle(0); sf(clampF(cur + unit)); }
    else if (k === 'i') sm(cur, Math.max(cur + 1, m?.out ?? cur + 1));
    else if (k === 'o') sm(Math.min(m?.in ?? 0, cur - 1), cur);
  };

  useEffect(() => {
    if (!keys) return;
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || blocksShortcutTarget(e.target) || document.querySelector('[role="alertdialog"]')) return;
      const k = e.key.toLowerCase();
      if ('jkl,.io'.includes(k) && k.length === 1) {
        e.preventDefault();
        act(k);
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, unit]);

  const { view } = z;
  const pc = (f: number) => ((f - view.start) / view.len) * 100 + '%';
  const whole = (f: number) => (f / Math.max(1, frames)) * 100 + '%';
  const range = marks ? marks.out - marks.in : 0;
  const bars = (range / beatF / 4).toFixed(2);
  return (
    <div className="slicebar">
      {previewTarget && <PreviewTransport target={previewTarget} frames={frames} frame={frame} fps={fps}
        playing={shuttleRate !== 0} seek={false}
        onSeek={f => { if (isCurrent?.() === false) return; setShuttle(0); setFrame(f); }}
        onToggle={() => { if (isCurrent?.() === false) return; if (shuttle.current) setShuttle(0); else act('l'); }}
        detail={shuttleRate ? 'Source shuttle ' + shuttleRate + '× · silent preview' : 'Source J / K / L · Space controls the edit'} />}
      {previewTarget && <div className="source-mark-actions">
        <button className="tbtn io" onClick={() => act('i')} title="Set IN at the source playhead (I)"><Icon name="mark-in" />Mark in</button>
        <button className="tbtn io o" onClick={() => act('o')} title="Set exclusive OUT at the source playhead (O)"><Icon name="mark-out" />Mark out</button>
        <span className="dim">Snap: {snap}</span>
      </div>}
      <details className="source-tools" open={previewTarget ? undefined : true}><summary>{previewTarget ? 'Shuttle & snap' : 'Source controls'}</summary>
      <div className="transport">
        <button className="tbtn" title="Shuttle reverse (J) — press again to go faster" onClick={() => act('j')}><Icon name="shuttle-rev" />Reverse J</button>
        <button className="tbtn" title="Pause source at this position (K)" onClick={() => act('k')}><Icon name="pause" />Pause K</button>
        <button className="tbtn" title="Shuttle forward (L) — press again to go faster" onClick={() => act('l')}><Icon name="shuttle-fwd" />Forward L</button>
        <button className="tbtn" title={`Step back one ${snap} (,)`} onClick={() => act(',')}>−1 {snap}</button>
        <button className="tbtn" title={`Step forward one ${snap} (.)`} onClick={() => act('.')}>+1 {snap}</button>
        <button className="tbtn io" title="Set IN at the playhead (I)" onClick={() => act('i')}><Icon name="mark-in" />I</button>
        <button className="tbtn io o" title="Set OUT at the playhead (O)" onClick={() => act('o')}><Icon name="mark-out" />O</button>
        {extra}
        <RadialPick
          title="Snap unit"
          className="tbtn snappick"
          value={snap}
          hint="Snap scrubbing and stepping to frame / beat / bar (project BPM) — radial chooser"
          options={[
            { label: 'frame', value: 'frame', color: 'var(--sky)', hint: 'Every frame' },
            { label: 'beat', value: 'beat', color: 'var(--fn-interactive)', hint: `One beat at ${bpm} BPM` },
            { label: 'bar', value: 'bar', color: 'var(--coral)', hint: 'Four beats' },
          ]}
          onChange={(s) => setUi({ snap: s as 'frame' | 'beat' | 'bar' })}
          label={`snap: ${snap}`}
        />
        <span className="audionote" title="Playback in the app is silent for now: there is no audio monitoring yet. Exports carry the clips' audio and the Audio Mirror.">🔇 silent preview · exports carry audio</span>
      </div>
      </details>
      <div ref={lane} className={'scrub' + (tall ? ' tall' : '')} onPointerDown={(e) => dragFrames(e, lane.current!, view, (f) => setFrame(snapF(f)))} role="slider" aria-label="Scrub" aria-valuemin={0} aria-valuemax={frames - 1} aria-valuenow={Math.round(frame)} tabIndex={0} title="Click or drag to scrub · wheel to zoom · Shift+wheel to pan · drag IN / OUT to move them">
        <Ticks view={view} steps={steps} label={rulerTime((f) => timecode(f, fps), fpsValue(fps))} className="big" />
        <div className="wave" />
        {chapters && (
          <div className="chaplayer">
            {chapters.map((c, i) => (
              <div key={c.id} className="chapreg" style={{ left: pc(c.start), width: ((c.end - c.start) / view.len) * 100 + '%' }}><span>{i + 1}</span></div>
            ))}
            {chapters.slice(1).map((c) => <div key={c.id + 'cut'} className="chapcut" style={{ left: pc(c.start) }} />)}
          </div>
        )}
        {marks && <MarkHandles identity={zoomKey} isCurrent={isCurrent} total={frames} projectGesture={!browseControl} view={view} marks={marks} setMarks={setMarks} snap={(f) => (f >= frames - 0.5 ? frames : snapF(f))} track={lane} />}
        <div className="ph" style={{ left: pc(frame) }}><span className="head" /></div>
      </div>
      <div className="slicenav">
        <ZoomNav total={frames} z={z}>
          {marks && <div className="znmark" style={{ left: whole(marks.in), width: whole(marks.out - marks.in) }} />}
          {chapters?.slice(1).map((c) => <i key={c.id} className="znchap" style={{ left: whole(c.start) }} />)}
          <i className="znph" style={{ left: whole(frame) }} />
        </ZoomNav>
        <ZoomButtons z={z} />
      </div>
      <div className="slicefoot">
        {!previewTarget && <span><MediaMark kind="frames" /> <b>{Math.round(frame)}</b> / {Math.max(0, frames - 1)} · <Timecode frame={frame} fps={fps} /></span>}
        {marks && (
          <>
            <span><MediaMark kind="in" /> <b>{marks.in}</b></span>
            <span><MediaMark kind="out" /> <b>{marks.out}</b></span>
            <span><MediaMark kind="range" /> <b>{range} frames</b> ≈ <b className="musval">{bars} bars</b></span>
          </>
        )}
        {marks && <span className="dim">Out is the first excluded frame</span>}
      </div>
    </div>
  );
}

/** Keep the global timeline playhead moving while ui.playing (Space). Repaint only (L9). */
export function usePlayback(totalFrames: number, fps: Rational) {
  const playing = useUi((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = uiStore.get().playhead;
    let shown = acc;
    const tick = () => {
      const t = performance.now();
      // A seek while playing (the audition's 2 s loop) moved the playhead: carry on from there.
      if (uiStore.get().playhead !== shown) acc = uiStore.get().playhead;
      acc = (acc + Math.max(0, (t - last) / 1000) * fpsValue(fps)) % Math.max(1, totalFrames);
      last = t;
      shown = Math.floor(acc);
      if (shown !== uiStore.get().playhead) setUi({ playhead: shown });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, totalFrames, fps]);
}
