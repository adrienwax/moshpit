import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectCuts, chaptersFromCuts } from '../src/conform/scenes';
import { planAudio } from '../src/runtime/audio';
import { findFfmpeg } from '../src/conform/ffmpeg';
import type { BlockId, ConformedSource, SourceId } from '../src/model';
import type { AudioSpan } from '../src/timeline/stage1';
import { AudioClock, RationalClock } from '../src/time/clock';
import { CACHE, conformed } from './helpers';

describe('scene detection (§1b, Moshpit 2.0 scdet)', () => {
  it('finds the two hard cuts on the conform\'s own frame numbers', async () => {
    const { record } = await conformed('src-cuts.mp4');
    const cuts = await detectCuts(record, 0.5);
    expect(cuts.map((c) => c.frame)).toEqual([90, 180]);
    const ch = chaptersFromCuts(cuts, record.frames, 0.5);
    expect(ch.map((c) => [c.start, c.end])).toEqual([[0, 90], [90, 180], [180, 270]]);
  });
  it('keeps user-edited chapters through a re-run', () => {
    const user = { id: 'u' as never, start: 10, end: 20, autoDetected: false, label: 'mine' };
    const ch = chaptersFromCuts([{ frame: 50, score: 30 }], 100, 0.5, [user, { ...user, id: 'x' as never, autoDetected: true }]);
    expect(ch.filter((c) => !c.autoDetected)).toEqual([user]);
    expect(ch.filter((c) => c.autoDetected).length).toBe(2);
  });
});

describe('per-clip audio assembly (L27, L28)', () => {
  const span = (id: string, s: SourceId, t: number, frames: number, clipFrame: number, mute = false, fit: AudioSpan['fit'] = 'straight', clipFrames = frames): AudioSpan => ({ blockId: id as BlockId, sourceId: s, timelineStart: t, frames, clipFrame, clipFrames, fit, mute });
  it('builds a track exactly sample(total) long: straight, looped on repeat, silent when muted or absent', async () => {
    const a = (await conformed('src-a.mp4')).record, b = (await conformed('src-b.mp4')).record, c = (await conformed('src-c.mp4')).record;
    const conforms = new Map<SourceId, ConformedSource>([[a.sourceId, a], [b.sourceId, b], [c.sourceId, c]]);
    const fps = { num: 30000, den: 1001 };
    const spans = [span('p1', a.sourceId, 0, 91, 0), span('m1', c.sourceId, 91, 33, 10), span('m2', b.sourceId, 124, 47, 5), span('m2', b.sourceId, 171, 47, 5), span('p2', a.sourceId, 218, 29, 100, true)];
    const wav = path.join(CACHE, 'audio-plan.wav');
    const plan = planAudio(spans, conforms, fps, [0, 246], wav);
    const r = spawnSync(findFfmpeg().ffmpeg, plan.args);
    expect(String(r.stderr)).toBe('');
    const clock = new AudioClock(new RationalClock(fps), 48000);
    expect(plan.samples).toBe(clock.sample(247));
    const pcm = fs.readFileSync(wav).subarray(44); // canonical 44-byte WAV header from ffmpeg bitexact
    expect(pcm.length / 4).toBe(plan.samples); // s16 stereo
    const rms = (from: number, n: number) => { let s = 0; for (let i = 0; i < n; i++) { const v = pcm.readInt16LE((from + i) * 4); s += v * v; } return Math.sqrt(s / n); };
    expect(rms(1000, 2000)).toBeGreaterThan(1000);                         // A's sine
    expect(rms(plan.spans[1].timelineStart && clock.sample(95), 1000)).toBe(0); // C has no audio
    expect(rms(clock.sample(130), 2000)).toBeGreaterThan(1000);            // B's sine
    expect(rms(clock.sample(225), 2000)).toBe(0);                          // muted
    // Repeat loops the audio: both repetitions of m2 read the same clip samples.
    expect(plan.spans[2].from).toBe(plan.spans[3].from);
    fs.rmSync(wav);
  });

  it('resamples for a speed op and stretches for a hold-style op, still exactly sample(total) long', async () => {
    const a = (await conformed('src-a.mp4')).record;
    const conforms = new Map<SourceId, ConformedSource>([[a.sourceId, a]]);
    const fps = { num: 30, den: 1 };
    const spans = [span('slow', a.sourceId, 0, 120, 0, false, 'resample', 60), span('held', a.sourceId, 120, 90, 30, false, 'stretch', 20)];
    const wav = path.join(CACHE, 'audio-fit.wav');
    const plan = planAudio(spans, conforms, fps, [0, 209], wav);
    const r = spawnSync(findFfmpeg().ffmpeg, plan.args);
    expect(String(r.stderr)).toBe('');
    expect((fs.readFileSync(wav).length - 44) / 4).toBe(new AudioClock(new RationalClock(fps), 48000).sample(210));
    fs.rmSync(wav);
  });
});
