import type { ReactNode } from 'react';
import type { Rational } from '@moshpit/engine';
import { Icon } from './Icon';
import { Timecode } from './MediaReadout';
import { barsBeats } from '../lib/time';
import './preview-transport.css';

export function boundedPreviewFrame(frame: number, frames: number) {
  return Math.max(0, Math.min(Math.max(0, frames - 1), Math.round(frame)));
}

/** Presentation only. Source and edit adapters retain ownership of their existing clocks. */
export function PreviewTransport({ target, frame, frames, fps, playing, onSeek, onToggle, seek = true, detail, bpm, boundaries = [] }: {
  target: string; frame: number; frames: number; fps: Rational; playing: boolean;
  onSeek: (frame: number) => void; onToggle: () => void; seek?: boolean; detail?: ReactNode; bpm?: number; boundaries?: number[];
}) {
  const last = Math.max(0, frames - 1);
  const at = boundedPreviewFrame(frame, frames);
  const go = (next: number) => onSeek(boundedPreviewFrame(next, frames));
  return <section className="preview-transport" aria-label={target + ' transport'} title={typeof detail === 'string' ? detail : undefined}>
    <div className="preview-target"><span>Controls</span><strong>{target}</strong><small>{playing ? 'Playing' : 'Paused'}</small></div>
    <div className="preview-buttons" role="group" aria-label={target + ' playback'}>
      <button disabled={!frames} onClick={() => go(0)} aria-label="Return to start" title="Return to the first frame and pause"><span aria-hidden="true">|◀</span><small>Start</small></button>
      <button disabled={!frames} onClick={() => go(at - 1)} aria-label="Previous frame" title="One frame back, then pause"><Icon name="back" size={18} /><small>−1 frame</small></button>
      <button className="preview-play" disabled={!frames} onClick={onToggle} aria-label={playing ? 'Pause' : 'Play'} title="Pause keeps the current position"><Icon name={playing ? 'pause' : 'play'} size={22} /><span>{playing ? 'Pause' : 'Play'}</span></button>
      <button disabled={!frames} onClick={() => go(at + 1)} aria-label="Next frame" title="One frame forward, then pause"><Icon name="forward" size={18} /><small>+1 frame</small></button>
      <button disabled={!frames} onClick={() => go(last)} aria-label="Go to last frame" title="Go to the last displayable frame and pause"><span aria-hidden="true">▶|</span><small>End</small></button>
    </div>
    <div className="preview-counters">
      <div><span>Time</span><b><Timecode frame={at} fps={fps} /></b><em>/ <Timecode frame={frames} fps={fps} /></em></div>
      {bpm && <div className="preview-bars"><span>Bar.beat</span><b>{barsBeats(at, fps, bpm)}</b></div>}
      <div title={frames + ' frames total; frame index starts at zero'}><span>Frame</span><b>{at}</b><em>/ {last}</em></div>
    </div>
    {seek && <div className="preview-seek-lane"><div className="preview-seek-boundaries" aria-hidden="true">{boundaries.filter(f => f > 0 && f < frames).map(f => <i key={f} style={{ left: `${f / Math.max(1, last) * 100}%` }} />)}</div><input className="preview-seek" type="range" min={0} max={last} step={1} value={at} disabled={!frames} aria-label={target + ' position'} aria-valuetext={'Frame ' + at + ' of ' + frames + ' frames'} onChange={e => go(Number(e.target.value))} /></div>}
    {detail && <div className="preview-detail">{detail}</div>}
  </section>;
}
