// L27 + L28: per-clip audio assembled for export. There is no master track: each block
// repetition plays its own clip's audio straight from the clip frame it starts at; repeat loops
// it; mute silences it; a clip with no audio contributes silence of exactly its length.
//
// Every span's length is measured on the *timeline's* sample grid — sample(end) − sample(start)
// from the one derived audio clock — so the assembled track is exactly sample(totalFrames) long
// and never drifts from the picture, however many spans there are. The source read starts at the
// clip's own sample(clipFrame), anchored at the clip start.

import type { ConformedSource, SourceId } from '../model';
import type { AudioSpan } from '../timeline/stage1';
import { AudioClock, RationalClock } from '../time/clock';
import type { Rational } from '@moshpit/core';

export const EXPORT_RATE = 48000;

export interface AudioPlan {
  /** ffmpeg arguments that write a 48 kHz stereo s16 WAV of exactly `samples` samples. */
  args: string[];
  samples: number;
  spans: { timelineStart: number; samples: number; source: string | null; from: number }[];
}

export function planAudio(spans: AudioSpan[], conforms: Map<SourceId, ConformedSource>, fps: Rational, range: [number, number], outWav: string): AudioPlan {
  const clock = new AudioClock(new RationalClock(fps), EXPORT_RATE);
  const [a, b] = range;
  const inputs: string[] = [];
  const inputIndex = new Map<string, number>();
  const parts: string[] = [];
  const planned: AudioPlan['spans'] = [];
  for (const s of spans) {
    const lo = Math.max(a, s.timelineStart), hi = Math.min(b + 1, s.timelineStart + s.frames);
    if (hi <= lo) continue;
    const n = clock.sample(hi) - clock.sample(lo);
    const c = conforms.get(s.sourceId);
    const label = `a${parts.length}`;
    if (!c?.audio || s.mute) {
      parts.push(`anullsrc=r=${EXPORT_RATE}:cl=stereo,atrim=end_sample=${n}[${label}]`);
      planned.push({ timelineStart: lo, samples: n, source: null, from: 0 });
      continue;
    }
    if (!inputIndex.has(c.path)) { inputIndex.set(c.path, inputs.length); inputs.push(c.path); }
    const src = `[${inputIndex.get(c.path)}:a:0]aresample=${EXPORT_RATE},aformat=sample_fmts=s16:channel_layouts=stereo`;
    let from: number;
    if (s.fit === 'resample') {
      // Tape-style: the clip's own range stretched over the block; pitch follows speed (L27).
      const ratio = s.clipFrames / s.frames;
      from = clock.sample(s.clipFrame + Math.floor((lo - s.timelineStart) * ratio));
      const take = clock.sample(s.clipFrame + s.clipFrames) - from;
      parts.push(`${src},atrim=start_sample=${from}:end_sample=${from + take},asetpts=PTS-STARTPTS,asetrate=${Math.round(EXPORT_RATE * ratio)},aresample=${EXPORT_RATE},apad,atrim=end_sample=${n}[${label}]`);
    } else if (s.fit === 'stretch') {
      // Pitch kept: atempo fits the clip range to the block. atempo takes 0.5–100 per stage, so chain stages.
      const tempo = s.clipFrames / s.frames;
      from = clock.sample(s.clipFrame + Math.floor((lo - s.timelineStart) * tempo));
      const take = clock.sample(s.clipFrame + s.clipFrames) - from;
      const stages: string[] = [];
      let t = tempo;
      while (t < 0.5) { stages.push('atempo=0.5'); t /= 0.5; }
      stages.push(`atempo=${t.toFixed(6)}`);
      parts.push(`${src},atrim=start_sample=${from}:end_sample=${from + take},asetpts=PTS-STARTPTS,${stages.join(',')},apad,atrim=end_sample=${n}[${label}]`);
    } else {
      from = clock.sample(s.clipFrame + (lo - s.timelineStart));
      // apad covers a clip whose audio ends a few samples before its last frame.
      parts.push(`${src},atrim=start_sample=${from},asetpts=PTS-STARTPTS,apad,atrim=end_sample=${n}[${label}]`);
    }
    planned.push({ timelineStart: lo, samples: n, source: c.path, from });
  }
  const total = clock.sample(b + 1) - clock.sample(a);
  const graph = `${parts.join(';')};${parts.map((_, i) => `[a${i}]`).join('')}concat=n=${parts.length}:v=0:a=1,aformat=sample_fmts=s16:channel_layouts=stereo[out]`;
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...inputs.flatMap((p) => ['-i', p]), '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', String(EXPORT_RATE), '-fflags', '+bitexact', '-map_metadata', '-1', outWav];
  return { args, samples: total, spans: planned };
}
