import '../styles/media-readouts.css';
import type { Rational } from '@moshpit/engine';
import { timecode } from '../lib/time';
import { Icon, type IconName } from './Icon';

/** Subdue only the leading zero prefix; keep the complete, selectable timecode. */
export function Timecode({ frame, fps, value, className = '' }: { frame?: number; fps?: Rational; value?: string; className?: string }) {
  const text = value ?? timecode(frame ?? 0, fps ?? { num: 30, den: 1 });
  const first = text.search(/[1-9]/);
  const split = /^\d+:\d{2}:\d{2}:\d{2,}$/.test(text) ? (first < 0 ? Math.max(0, text.length - 2) : first) : 0;
  return <span className={`timecode ${className}`}><span className="tc-leading">{text.slice(0, split)}</span><span>{text.slice(split)}</span></span>;
}

export type MediaMarkKind = 'in' | 'out' | 'frames' | 'duration' | 'rate' | 'range' | 'source';
const MARKS: Record<MediaMarkKind, { icon: IconName; label: string }> = {
  in: { icon: 'mark-in', label: 'In' }, out: { icon: 'mark-out', label: 'Out' },
  frames: { icon: 'frames', label: 'Frames' }, duration: { icon: 'time', label: 'Duration' },
  rate: { icon: 'rate', label: 'Rate' }, range: { icon: 'range', label: 'Range' },
  source: { icon: 'source', label: 'Source' },
};
/** Shared visual vocabulary: direction/shape carries meaning, colour is not required. */
export function MediaMark({ kind, label, title }: { kind: MediaMarkKind; label?: string; title?: string }) {
  return <span className={`media-mark media-mark-${kind}`} title={title}><Icon name={MARKS[kind].icon} size={14} /><span>{label ?? MARKS[kind].label}</span></span>;
}
