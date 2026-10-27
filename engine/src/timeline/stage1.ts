// §1f STAGE 1 — the timeline-level mosher. Encoded domain, cross-block.
//
//   picture/motion blocks in order
//     → assemble the conformed encoded streams end to end
//     → apply the seam mosh (a motion block carries no keyframe, so its P-frames smear over
//       whatever picture is on screen) and each block's in-block encoded ops (reorder)
//     → renumber frame_num across every splice so the decoder withholds nothing
//     → one EncodedVideoStream + its decode plan + its audio plan
//
// Exactly one decode boundary follows; stage 2 (per-block GPU graphs) never sees encoded data.
//
// Time: a timeline frame is a slot on the one rational clock. A removed keyframe is a slot with
// no sample — it evaluates as "hold the last decoded picture" — so the clock never shifts and a
// clip's audio stays aligned (L27). Primer samples (decoded to reach a picture block's in-point)
// have no slot at all.

import { MoshpitError } from '../errors';
import type { Block, BlockId, ConformedSource, SourceId, Rational } from '../model';
import { mix32 } from '../util/determinism';
import { readSliceHeader, spliceParameterSets, writeFrameNumInto } from '../bitstream/h264';
import { applyBitstreamOp } from '../nodes/ops/bitstream';
import type { Mp4Video, SampleReader } from '../bitstream/mp4';

/** An encoded-domain op from a block's own graph, in block-local frames (B1: in-block only). */
export type EncodedOp =
  | { kind: 'reorder'; mode: 'reverse' | 'pingpong' | 'stride'; from: number; to: number }
  /** One of Moshpit 1's bitstream ops (nodes/ops/bitstream.ts), by node kind, with its numeric params. */
  | { kind: 'map'; op: string; params: Record<string, number> };

export interface ClipInput {
  record: ConformedSource;
  /** The demuxed master or proxy, per `variant`. */
  video: Mp4Video;
  reader: SampleReader;
}

export interface PlannedSample {
  clip: number;
  src: number;
  key: boolean;
  /** The frame_num this sample must carry in the assembled stream. */
  frameNum: number;
  /** True when frameNum differs from what is in the file, so the bytes must be rewritten. */
  rewrite: boolean;
  /** Timeline frame this sample's picture lands on, or -1 for a primer sample. */
  t: number;
}

export interface BlockSpan {
  blockId: BlockId;
  kind: Block['kind'];
  /** Timeline frames [start, end) of one repetition. */
  start: number;
  end: number;
  repetition: number;
}

/** L27/L28: base audio plays straight at its natural positions; repeat loops it. */
export interface AudioSpan {
  blockId: BlockId;
  sourceId: SourceId;
  timelineStart: number;
  frames: number;
  /** First frame of the clip whose audio plays at timelineStart. */
  clipFrame: number;
  /** Clip frames the block covers before any bitstream op changed its length. */
  clipFrames: number;
  /**
   * L27: how the clip's audio fills the block. `straight` plays at natural positions; `resample`
   * (a speed op changed the length) fits the clip range to the block tape-style, pitch following
   * speed; `stretch` (hold, ping-pong, stride… changed the length) fits it with pitch kept.
   * Block repeat loops by construction: each repetition is its own span.
   */
  fit: 'straight' | 'resample' | 'stretch';
  mute: boolean;
}

export interface Stage1Plan {
  variant: 'master' | 'proxy';
  /** `clean` decodes every block as a picture block: the reference the GPU PROXY smears from. */
  clean: boolean;
  fps: Rational;
  width: number;
  height: number;
  codecString: string;
  /** The WebCodecs `description` for the whole assembled stream. */
  avcC: Uint8Array;
  frameNumBits: number;
  clips: ClipInput[];
  /** Decode order. */
  samples: PlannedSample[];
  frames: number;
  /** Timeline frame → decode-sample index whose picture is shown there. */
  shown: Int32Array;
  /** 1 where the slot has no sample of its own (a removed keyframe). */
  held: Uint8Array;
  /** GOP evaluator: decode-sample index → index of the keyframe its decode must start from. */
  segStart: Int32Array;
  /**
   * Per timeline frame: a hash of every encoded input its picture depends on (the chain from its
   * segment's keyframe). Equal keys ⇒ identical decoded pixels. Dirty ranges and freeze keys read it (B2).
   */
  frameKey: Float64Array;
  /** Timeline ranges [start, end) where the picture differs from a clean decode: seam bleeds, removed keyframes, reorders. */
  moshRanges: [number, number][];
  /** Timeline frames where the GPU PROXY must hold the previous picture (F1: every removed keyframe, not just the range start). */
  proxyHold: Uint8Array;
  blocks: BlockSpan[];
  audio: AudioSpan[];
}

export interface Stage1Input {
  blocks: Block[];
  clips: Map<SourceId, ClipInput>;
  fps: Rational;
  encodedOps?: Map<BlockId, EncodedOp[]>;
  variant?: 'master' | 'proxy';
  clean?: boolean;
}

const REORDER = {
  reverse: (w: number[]) => w.slice().reverse(),
  pingpong: (w: number[]) => { const h = Math.ceil(w.length / 2); return w.map((_, j) => w[j < h ? j : w.length - 1 - j]); },
  stride: (w: number[]) => w.filter((_, j) => j % 2 === 0).concat(w.filter((_, j) => j % 2 === 1)),
};

interface HeaderCache { frameNum: Int32Array; ref: Uint8Array }
const headerCache = new WeakMap<Mp4Video, HeaderCache>();

/** frame_num and nal_ref_idc of every sample of a clip, read once (64 bytes per sample). */
function headers(c: ClipInput): HeaderCache {
  let h = headerCache.get(c.video);
  if (h) return h;
  const n = c.video.samples.length, bits = c.video.sps!.frameNumBits;
  h = { frameNum: new Int32Array(n), ref: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const s = readSliceHeader(c.reader.view(i), bits);
    h.frameNum[i] = s.frameNum; h.ref[i] = s.nalRefIdc > 0 ? 1 : 0;
  }
  headerCache.set(c.video, h);
  return h;
}

export function compileStage1(input: Stage1Input): Stage1Plan {
  const { blocks, fps } = input;
  const variant = input.variant ?? 'master', clean = !!input.clean;
  if (!blocks.length) throw new MoshpitError('TIMELINE_EMPTY');
  if (blocks[0].kind !== 'picture') throw new MoshpitError('TIMELINE_NO_PICTURE', { blockId: blocks[0].id });

  const clipIndex = new Map<SourceId, number>();
  const clips: ClipInput[] = [];
  let avcC: Uint8Array | undefined;
  for (const b of blocks) {
    if (clipIndex.has(b.sourceId)) continue;
    const c = input.clips.get(b.sourceId);
    if (!c) throw new MoshpitError('MEDIA_FILE_MISSING', { sourceId: b.sourceId, blockId: b.id });
    if (!c.record.moshable || !c.video.sps) throw new MoshpitError('CONFORM_NOT_MOSHABLE', { sourceId: b.sourceId });
    if (c.record.fps.num * fps.den !== fps.num * c.record.fps.den) throw new MoshpitError('BITSTREAM_SPLICE_INCOMPATIBLE', { sourceId: b.sourceId, why: 'frame rate differs from the project' });
    const merged = avcC ? spliceParameterSets(avcC, c.video.avcC) : c.video.avcC;
    if (!merged) throw new MoshpitError('BITSTREAM_SPLICE_INCOMPATIBLE', { sourceId: b.sourceId });
    avcC = merged;
    clipIndex.set(b.sourceId, clips.length);
    clips.push(c);
  }
  const bits = clips[0].video.sps!.frameNumBits, maxFn = 1 << bits;

  // Pass 1: the slot list. Each timeline slot is (clip, src) or a hold; primer samples ride along.
  const order: { clip: number; src: number; t: number }[] = []; // t = -1 primer, otherwise the slot
  const holds: number[] = [];
  const spans: BlockSpan[] = [];
  const audio: AudioSpan[] = [];
  const proxyHoldList: number[] = [];
  let t = 0;
  for (const b of blocks) {
    const ci = clipIndex.get(b.sourceId)!, c = clips[ci], nFrames = c.video.samples.length;
    if (!(b.in >= 0 && b.out <= nFrames && b.out > b.in)) throw new MoshpitError('BLOCK_RANGE_INVALID', { blockId: b.id, in: b.in, out: b.out, frames: nFrames });
    const isKey = (i: number) => c.video.samples[i].key;
    const picture = clean || b.kind === 'picture';
    const base: number[] = [];
    for (let i = b.in; i < b.out; i++) base.push(i);
    let list = base;
    const reorderStarts: number[] = [];
    for (const op of input.encodedOps?.get(b.id) ?? []) {
      if (op.kind === 'map') { list = applyBitstreamOp(op.op, list, op.params); if (!clean) reorderStarts.push(0); continue; }
      if (op.kind !== 'reorder') continue;
      // A reorder works on the P-frames of ONE GOP. The window is clamped to that: a keyframe at its
      // start stays put as the GOP's head, and it ends at the next keyframe. The node's default
      // (0–30) starts on the keyframe every conformed slice begins with; it used to throw
      // BITSTREAM_REORDER_CROSSES_KEYFRAME and fail the whole edit (preview and every export).
      let from = Math.max(0, op.from);
      while (from < list.length && isKey(list[from])) from++;
      let to = Math.min(list.length, op.to);
      for (let i = from; i < to; i++) if (isKey(list[i])) { to = i; break; }
      if (to - from < 2) continue;
      const win = list.slice(from, to);
      list = [...list.slice(0, from), ...REORDER[op.mode](win), ...list.slice(to)];
      reorderStarts.push(from);
    }
    const reps = Math.max(1, Math.round(b.repeat));
    for (let r = 0; r < reps; r++) {
      const start = t;
      if (picture) {
        // Primer (Moshpit 1's render-time primer, Studio.tsx:1527): decode from the clip's last
        // keyframe at or before the in-point, silently, so the visible block can start anywhere.
        const first = list[0];
        let k = first;
        while (k > 0 && !isKey(k)) k--;
        for (let i = k; i < first; i++) order.push({ clip: ci, src: i, t: -1 });
      }
      for (let j = 0; j < list.length; j++) {
        const src = list[j];
        const removed = !picture && isKey(src) && !b.seam.keepInnerKeyframes;
        if (removed) { holds.push(t); if (!clean) proxyHoldList.push(t); }
        else order.push({ clip: ci, src, t });
        t++;
      }
      if (!clean) {
        if (!picture) proxyHoldList.push(start); // the seam itself
        for (const r0 of reorderStarts) proxyHoldList.push(start + r0);
      }
      spans.push({ blockId: b.id, kind: b.kind, start, end: t, repetition: r });
      const speedOp = (input.encodedOps?.get(b.id) ?? []).some((o) => o.kind === 'map' && (o.op === 'mosh.speed' || o.op === 'mosh.speed-ramp'));
      const fit = t - start === b.out - b.in ? 'straight' : speedOp ? 'resample' : 'stretch';
      audio.push({ blockId: b.id, sourceId: b.sourceId, timelineStart: start, frames: t - start, clipFrame: b.in, clipFrames: b.out - b.in, fit, mute: b.audio.mute });
    }
  }
  const frames = t;

  // Pass 2: frame_num assignment, the GOP evaluator and the chain hash, in decode order.
  const samples: PlannedSample[] = new Array(order.length);
  const segStart = new Int32Array(order.length);
  const chain = new Float64Array(order.length);
  let fn = 0, prevRef = false, seg = 0, h1 = 0, h2 = 0;
  for (let k = 0; k < order.length; k++) {
    const o = order[k], c = clips[o.clip], hd = headers(c);
    const key = c.video.samples[o.src].key;
    const want = key ? 0 : (prevRef ? (fn + 1) % maxFn : fn);
    fn = want; prevRef = hd.ref[o.src] === 1;
    const rewrite = !key && hd.frameNum[o.src] !== want;
    samples[k] = { clip: o.clip, src: o.src, key, frameNum: want, rewrite, t: o.t };
    if (key) { seg = k; h1 = 0x6d6f7368; h2 = 0x70697433; }
    segStart[k] = seg;
    // Identity of this decode input: which bytes of which conform, with which frame_num.
    const id = mix32(c.record.conformedHash ? hashHex(c.record.conformedHash) : o.clip) ^ mix32(o.src * 2 + (key ? 1 : 0)) ^ mix32(want + 0x1000);
    h1 = mix32(h1 ^ id); h2 = mix32(h2 + Math.imul(id, 0x27d4eb2d));
    chain[k] = (h1 >>> 0) * 2097152 + (h2 & 0x1fffff);
  }

  const shown = new Int32Array(frames).fill(-1), held = new Uint8Array(frames);
  for (let k = 0; k < samples.length; k++) if (samples[k].t >= 0) shown[samples[k].t] = k;
  for (const h of holds) held[h] = 1;
  for (let i = 0; i < frames; i++) {
    if (shown[i] >= 0) continue;
    if (i === 0) throw new MoshpitError('TIMELINE_NO_PICTURE');
    shown[i] = shown[i - 1];
  }
  const frameKey = new Float64Array(frames);
  for (let i = 0; i < frames; i++) frameKey[i] = chain[shown[i]];

  const proxyHold = new Uint8Array(frames);
  for (const p of proxyHoldList) if (p >= 0 && p < frames) proxyHold[p] = 1;

  const ref = clips[0];
  const description = avcC!;
  const codecString = `avc1.${Array.from(description.subarray(1, 4), v => v.toString(16).padStart(2, '0')).join('')}`;
  return {
    variant, clean, fps, width: ref.video.width, height: ref.video.height, codecString, avcC: description,
    frameNumBits: bits, clips, samples, frames, shown, held, segStart, frameKey,
    moshRanges: moshRangesOf(samples, held, shown, segStart, frames), proxyHold, blocks: spans, audio,
  };
}

const hashHex = (hex: string) => parseInt(hex.slice(0, 8), 16) | 0;

/**
 * Where the picture differs from a clean decode: from every irregular join (a sample whose decode
 * predecessor is not its natural predecessor, or a hold) until the decode chain restarts at a
 * keyframe after the join — which may be a primer keyframe before a picture block's first slot.
 * The spike's `affectedRanges`, generalised from one clip to a spliced timeline.
 */
function moshRangesOf(samples: PlannedSample[], held: Uint8Array, shown: Int32Array, segStart: Int32Array, frames: number): [number, number][] {
  const joins: [number, number][] = []; // [slot, decode index the join depends on]
  for (let k = 1; k < samples.length; k++) {
    const s = samples[k], p = samples[k - 1];
    if (!s.key && s.t >= 0 && !(s.clip === p.clip && s.src === p.src + 1)) joins.push([s.t, k]);
  }
  for (let i = 0; i < frames; i++) if (held[i]) joins.push([i, shown[i]]);
  joins.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [st, kj] of joins) {
    let e = st + 1;
    while (e < frames && segStart[shown[e]] <= kj) e++;
    const last = out[out.length - 1];
    if (last && last[1] >= st) last[1] = Math.max(last[1], e);
    else out.push([st, e]);
  }
  return out;
}

let rewriteBuf = new Uint8Array(1 << 20);

/**
 * The bytes to feed the decoder for decode-sample k: a view into a reused buffer, valid until the
 * next call (EncodedVideoChunk copies on construction). Allocation-free for rewritten samples (L21).
 */
export function sampleBytes(plan: Stage1Plan, k: number): Uint8Array {
  const s = plan.samples[k];
  const r = plan.clips[s.clip].reader;
  if (!s.rewrite) return r.view(s.src);
  const off = r.locate(s.src), n = plan.clips[s.clip].video.samples[s.src].size;
  if (rewriteBuf.length < n + 64) rewriteBuf = new Uint8Array(n * 2 + 64);
  // ponytail: one subarray view per chunk (~70 B); EncodedVideoChunk needs an exact-length BufferSource.
  return rewriteBuf.subarray(0, writeFrameNumInto(r.buf, plan.frameNumBits, s.frameNum, rewriteBuf, n, off));
}

/**
 * T4 generalised: the timeline frames whose decoded picture changes between two plans. Equal
 * frame keys ⇒ identical pixels, so this is exact, not a heuristic. Stateful stage-2 nodes extend
 * a dirty frame to the end of its block repetition (S1: state resets at the boundary).
 */
export function dirtyFrames(a: Stage1Plan, b: Stage1Plan): Uint8Array {
  const n = b.frames, d = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (i >= a.frames || a.frameKey[i] !== b.frameKey[i]) d[i] = 1;
  return d;
}

/** Contiguous [start, end) runs of a 0/1 mask. */
export function runs(mask: Uint8Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const s = i;
    while (i < mask.length && mask[i]) i++;
    out.push([s, i]);
  }
  return out;
}
