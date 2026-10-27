import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { compileStage1, dirtyFrames, runs, sampleBytes, type ClipInput, type Stage1Plan } from '../src/timeline/stage1';
import { annexBParameterSets, toAnnexB, writeFrameNum } from '../src/bitstream/h264';
import { openSamples } from '../src/bitstream/mp4';
import { findFfmpeg } from '../src/conform/ffmpeg';
import type { Block, BlockId, SourceId } from '../src/model';
import { conformed } from './helpers';

const clips = new Map<SourceId, ClipInput>();
const A = 'A' as SourceId, B = 'B' as SourceId, C = 'C' as SourceId;

beforeAll(async () => {
  for (const [id, name] of [[A, 'src-a.mp4'], [B, 'src-b.mp4'], [C, 'src-c.mp4']] as const) {
    const { record, video } = await conformed(name);
    clips.set(id, { record, video, reader: openSamples(video) });
  }
});
afterAll(() => { for (const c of clips.values()) c.reader.close(); });

const blk = (id: string, kind: Block['kind'], sourceId: SourceId, inF: number, out: number, repeat = 1, keepInner = false): Block => ({
  id: id as BlockId, kind, sourceId, in: inF, out, repeat, seam: { kind: 'seam.mosh', defVersion: 1, keepInnerKeyframes: keepInner },
  graph: { nodes: [], edges: [] }, audio: { mute: false }, refs: [],
});

// Keyframes in every conform sit at 0, 120, 240 (GOP 120).
const TIMELINE = () => [
  blk('p1', 'picture', A, 0, 90),
  blk('m1', 'motion', C, 30, 150),          // crosses C's keyframe at 120 → a hold
  blk('m2', 'motion', B, 10, 70, 2),        // repeated: the bloom
  blk('p2', 'picture', A, 100, 200),        // in-point mid-GOP → primer 0..99
  blk('m3', 'motion', B, 125, 200),
];
const OPS = new Map([['m3' as BlockId, [{ kind: 'reorder' as const, mode: 'reverse' as const, from: 5, to: 40 }]]]);
const fps = { num: 30, den: 1 };

/** Assemble the plan's stream as Annex-B and decode it with ffmpeg: an independent decoder. */
function ffDecode(plan: Stage1Plan, renumber = true) {
  const parts: Uint8Array[] = [annexBParameterSets(plan.avcC)];
  for (let k = 0; k < plan.samples.length; k++) {
    const bytes = renumber ? sampleBytes(plan, k).slice() : plan.clips[plan.samples[k].clip].reader.view(plan.samples[k].src).slice();
    parts.push(toAnnexB(bytes));
  }
  const input = Buffer.concat(parts);
  const r = spawnSync(findFfmpeg().ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'h264', '-i', '-', '-f', 'framemd5', '-'], { input, maxBuffer: 64 << 20 });
  const md5 = String(r.stdout).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
  return { frames: md5.length, md5, stderr: String(r.stderr).trim() };
}

describe('stage 1: timeline mosher (§1f)', () => {
  it('lays out slots: holds keep the clock, primers take no slot, repeat multiplies', () => {
    const p = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    expect(p.frames).toBe(90 + 120 + 60 * 2 + 100 + 75);
    expect(p.held.reduce((a, b) => a + b, 0)).toBe(1); // C's keyframe 120 inside m1
    expect(p.held[90 + (120 - 30)]).toBe(1);
    const primers = p.samples.filter((s) => s.t < 0).length;
    expect(primers).toBe(100);
    expect(p.samples.length).toBe(p.frames - 1 + primers);
    expect(p.blocks.map((b) => [b.blockId, b.start, b.end])).toEqual([
      ['p1', 0, 90], ['m1', 90, 210], ['m2', 210, 270], ['m2', 270, 330], ['p2', 330, 430], ['m3', 430, 505]]);
  });

  it('decodes on an independent decoder with every sample delivered and no complaint', () => {
    const p = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    const d = ffDecode(p);
    expect(d.stderr).toBe('');
    expect(d.frames).toBe(p.samples.length);
  });

  it('negative control: the same splice without frame_num renumbering upsets the decoder', () => {
    const p = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    expect(p.samples.some((s) => s.rewrite)).toBe(true);
    const d = ffDecode(p, false);
    // ffmpeg conceals rather than withholds, but it reports the frame_num gaps it had to invent around.
    expect(d.stderr.length > 0 || d.frames !== p.samples.length).toBe(true);
  });

  it('mosh ranges start at each seam and run to the next picture block', () => {
    const p = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    expect(p.moshRanges).toEqual([[90, 330], [430, 505]]);
    expect([90, 210, 270, 430, 435].every((t) => p.proxyHold[t] === 1)).toBe(true);
    expect(p.proxyHold[90 + 90]).toBe(1); // F1: the removed keyframe inside m1 holds too
  });

  it('a clean plan decodes every block as a picture: no holds, no mosh', () => {
    const p = compileStage1({ blocks: TIMELINE(), clips, fps, clean: true });
    expect(p.held.every((h) => h === 0)).toBe(true);
    expect(p.moshRanges).toEqual([]);
    expect(ffDecode(p).stderr).toBe('');
  });

  it('rewrites frame_num without allocating, byte-identical to the full rewrite (L21)', () => {
    const p = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    let n = 0;
    for (let k = 0; k < p.samples.length; k++) {
      const s = p.samples[k];
      if (!s.rewrite) continue;
      const full = writeFrameNum(p.clips[s.clip].reader.view(s.src), p.frameNumBits, s.frameNum);
      expect(Buffer.from(sampleBytes(p, k)).equals(Buffer.from(full))).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(300);
  });

  it('compiles deterministically (L11)', () => {
    const a = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    const b = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    expect(Buffer.from(a.frameKey.buffer).equals(Buffer.from(b.frameKey.buffer))).toBe(true);
  });

  it('frame keys are exact: equal key ⇒ identical decoded picture', () => {
    const p = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    const d = ffDecode(p);
    const pic = (t: number) => d.md5[p.shown[t]];
    const seen = new Map<number, string>();
    for (let t = 0; t < p.frames; t++) {
      const k = p.frameKey[t];
      if (seen.has(k)) expect(pic(t)).toBe(seen.get(k));
      else seen.set(k, pic(t));
    }
    // Repeat 2 of m2 smears over a different picture than repeat 1, so its keys must differ.
    expect(p.frameKey[215]).not.toBe(p.frameKey[275]);
  });

  it('an upstream edit dirties exactly the frames whose decode inputs changed (T4)', () => {
    const before = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    const edited = TIMELINE();
    edited[1] = { ...edited[1], in: 40 }; // trim m1's head; length changes by 10
    const after = compileStage1({ blocks: edited, clips, fps, encodedOps: OPS });
    const r = runs(dirtyFrames(before, after));
    expect(r[0][0]).toBe(90); // nothing before the edited block moves
    // Everything after shifts by 10 frames up to the next keyframe-led picture block, which re-primes.
    expect(r.every(([s]) => s >= 90)).toBe(true);
  });

  it('refuses a motion block first', () => {
    expect(() => compileStage1({ blocks: [blk('m', 'motion', A, 1, 50)], clips, fps })).toThrowError(/TIMELINE_NO_PICTURE/);
  });

  // Waxy's render failure (2026-10-08): the Reorder node's default window (0–30) starts on the
  // keyframe every conformed slice begins with, and used to throw BITSTREAM_REORDER_CROSSES_KEYFRAME,
  // failing preview and every export. The window now keeps to the P-frames of one GOP.
  const shownSrc = (blocks: Block[], ops: Map<BlockId, { kind: 'reorder'; mode: 'reverse'; from: number; to: number }[]>) =>
    compileStage1({ blocks, clips, fps, encodedOps: ops }).samples.filter((x) => x.t >= 0).sort((a, b) => a.t - b.t).map((x) => x.src);
  it('a reorder window starting on a keyframe keeps the keyframe as its head and reverses the P-frames after it', () => {
    const src = shownSrc([blk('p1', 'picture', A, 0, 90)], new Map([['p1' as BlockId, [{ kind: 'reorder', mode: 'reverse', from: 0, to: 10 }]]]));
    expect(src.slice(0, 11)).toEqual([0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 10]);
  });
  it('a reorder window over a GOP boundary stops at the keyframe, which stays in place', () => {
    // C has a keyframe at 120: a block from 100, window 0–40, reverses 100–119 and leaves 120 on.
    const src = shownSrc([blk('p2', 'picture', C, 100, 150)], new Map([['p2' as BlockId, [{ kind: 'reorder', mode: 'reverse', from: 0, to: 40 }]]]));
    expect(src.slice(0, 21)).toEqual([...Array.from({ length: 20 }, (_, i) => 119 - i), 120]);
  });

  it('plans per-clip audio: straight, looped on repeat, muted per block (L27)', () => {
    const blocks = TIMELINE();
    blocks[3] = { ...blocks[3], audio: { mute: true } };
    const p = compileStage1({ blocks, clips, fps, encodedOps: OPS });
    expect(p.audio.map((a) => [a.blockId, a.timelineStart, a.frames, a.clipFrame, a.mute])).toEqual([
      ['p1', 0, 90, 0, false], ['m1', 90, 120, 30, false], ['m2', 210, 60, 10, false], ['m2', 270, 60, 10, false],
      ['p2', 330, 100, 100, true], ['m3', 430, 75, 125, false]]);
  });

  it('compiles the proxy variant with the identical slot structure (decision 2)', async () => {
    const proxyClips = new Map<SourceId, ClipInput>();
    const { demux } = await import('../src/bitstream/mp4');
    for (const [id, c] of clips) { const v = demux(c.record.proxy!.path); proxyClips.set(id, { record: c.record, video: v, reader: openSamples(v) }); }
    const m = compileStage1({ blocks: TIMELINE(), clips, fps, encodedOps: OPS });
    const p = compileStage1({ blocks: TIMELINE(), clips: proxyClips, fps, encodedOps: OPS, variant: 'proxy' });
    expect([p.width, p.height]).toEqual([160, 90]);
    expect(p.frames).toBe(m.frames);
    expect(Array.from(p.shown)).toEqual(Array.from(m.shown));
    expect(p.moshRanges).toEqual(m.moshRanges);
    expect(ffDecode(p).stderr).toBe('');
    for (const c of proxyClips.values()) c.reader.close();
  });
});
