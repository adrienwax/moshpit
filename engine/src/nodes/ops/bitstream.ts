// The 7 bitstream ops, ported from Moshpit 1 (src/ops.ts cfd5d8c, OPS.hold … OPS.speedRamp `apply`
// and `length`). They are encoded-domain nodes (Mosh, ENCODED_STREAM): stage 1 applies them to the
// block's list of source frames before anything is decoded, inside Moshpit 1's shared window
// (`win from` / `win len`, percentages of the block). Repeated P-frames re-apply their motion,
// dropped ones leave gaps: the decoder does its ordinary job on a different sequence. The
// frame_num layer keeps every result decodable; refs = 1 keeps reorders legal (L29).

import { kind, port, type NodeDef, type ParamDef } from '@moshpit/core';
import { P } from './spec';

const WIN = [
  P('winFrom', 'Window from', 'float', 0, 'Where in the block the effect begins. 0 is the first frame.', { min: 0, max: 99, unit: '%', modulatable: false }),
  P('winLen', 'Window length', 'float', 100, 'How much of the block it covers. 100 is all of it.', { min: 1, max: 100, unit: '%', modulatable: false }),
];

function op(k: string, label: string, blurb: string, params: ParamDef[]): NodeDef {
  return {
    kind: kind(k), defVersion: 1, label, blurb, category: 'Mosh', family: 'Bitstream', domain: 'ENCODED_STREAM',
    inputs: [{ key: port('in'), label: 'Stream', type: 'EncodedVideoStream', cardinality: 'required-one' }],
    outputs: [{ key: port('out'), label: 'Stream', type: 'EncodedVideoStream' }],
    params: [...params.map((p) => ({ ...p, modulatable: false })), ...WIN],
    temporal: { mode: 'segment', lookBehind: 0, lookAhead: 0, seekPolicy: 'decode-from-segment-start', initialState: 'none: the op rewrites which encoded frames the block feeds the decoder', boundary: 'reset' },
    // The preview decodes the real rewritten stream (on the proxy at scrub size), so the op itself is exact.
    impl: { preview: 'EXACT', export: 'EXACT' }, determinism: { deterministic: true },
    resources: { workingTextures: 0, stateFrames: 0 }, failure: { codes: ['DECODE_FRAMES_WITHHELD'], onUnavailable: 'pass-through' }, freezable: false,
  };
}

export const BITSTREAM_DEFS: NodeDef[] = [
  op('mosh.hold', 'Hold', 'Repeat frames. Their motion re-applies and the picture drifts: the classic bloom.', [
    P('at', 'At', 'float', 0, 'Where in the window to hold, as a percentage of it.', { min: 0, max: 100, unit: '%', onNode: true, ctOrder: 1 }),
    P('span', 'Span', 'int', 1, 'How many frames are held. 1 freezes; more loops that many frames.', { min: 1, max: 60, step: 1, unit: 'f', onNode: true, ctOrder: 2 }),
    P('times', 'Times', 'int', 8, 'How many times the held run repeats. More repeats, more drift.', { min: 2, max: 120, step: 1, unit: '×', onNode: true, ctOrder: 3 })]),
  op('mosh.stride', 'Stride', 'Keep every Nth frame. Motion arrives with gaps.', [
    P('every', 'Every', 'int', 3, 'Keep one frame out of this many. 2 keeps half, 4 a quarter.', { min: 2, max: 24, step: 1, onNode: true, ctOrder: 1 }),
    P('offset', 'Offset', 'int', 0, 'Which frame of each group survives. Wraps at the group size.', { min: 0, max: 11, step: 1, onNode: true, ctOrder: 2 }),
    P('invert', 'Invert', 'bool', false, 'Drop one in N instead of keeping one in N.', { onNode: true, ctOrder: 3 })]),
  op('mosh.reverse', 'Reverse', 'Play backwards. Motion applies the wrong way.', [
    P('chunk', 'Chunk', 'int', 0, 'Reverse in groups of this many frames. 0 reverses the whole window.', { min: 0, max: 60, step: 1, unit: 'f', onNode: true, ctOrder: 1 })]),
  op('mosh.pingpong', 'Ping-pong', 'Forward, then backward. The run folds onto itself.', [
    P('laps', 'Laps', 'int', 1, 'How many out-and-back passes over the window.', { min: 1, max: 8, step: 1, onNode: true, ctOrder: 1 }),
    P('pause', 'Pause', 'int', 0, 'Frames held at each turnaround, where the motion reverses.', { min: 0, max: 30, step: 1, unit: 'f', onNode: true, ctOrder: 2 }),
    P('doubleEnds', 'Double ends', 'bool', false, 'Keep the first and last frame in the return pass as well.', { onNode: true, ctOrder: 3 })]),
  op('mosh.stride-slip', 'Stride slip', 'Motion updates once every N frames; the rest repeat the last real one. A stutter, not a cut: same length in, same length out.', [
    P('every', 'Every', 'int', 3, 'A new frame lands once out of this many. The rest repeat it.', { min: 2, max: 24, step: 1, onNode: true, ctOrder: 1 }),
    P('offset', 'Offset', 'int', 0, 'Which frame of each group is the one that updates.', { min: 0, max: 11, step: 1, onNode: true, ctOrder: 2 })]),
  op('mosh.speed', 'Speed', 'Play the block faster or slower at any rate. Repeated frames re-apply their motion, so slowing down smears.', [
    P('rate', 'Rate', 'float', 100, '100 is untouched. 50 is half speed and twice as long; 200 is double speed and half as long.', { min: 10, max: 400, unit: '%', onNode: true, ctOrder: 1 })]),
  op('mosh.speed-ramp', 'Speed ramp', 'Speed that changes across the block: wind up, or grind to a halt.', [
    P('rateIn', 'Rate in', 'float', 100, 'Rate at the start of the block. 100 is untouched.', { min: 10, max: 400, unit: '%', onNode: true, ctOrder: 1 }),
    P('rateOut', 'Rate out', 'float', 40, 'Rate at the end. Below rate in it slows across the block; above, it speeds up.', { min: 10, max: 400, unit: '%', onNode: true, ctOrder: 2 })]),
];

const int = (v: number | undefined, d: number) => (Number.isFinite(v) ? Math.round(v as number) : d);

/** Moshpit 1's windowOf: the frame range an op touches, from its window percentages. */
export function windowOf(n: number, p: Record<string, number>): [number, number] {
  const from = Math.min(99, Math.max(0, int(p.winFrom, 0)));
  const len = Math.min(100, Math.max(1, int(p.winLen, 100)));
  const a = Math.min(Math.max(0, n - 1), Math.floor((from * n) / 100));
  const b = Math.min(n, Math.max(a + 1, a + Math.ceil((len * n) / 100)));
  return [a, b];
}

/** Each op's `apply`, ported to an index list (the list holds source-frame numbers). */
export const TRANSFORMS: Record<string, (w: number[], p: Record<string, number>) => number[]> = {
  'mosh.hold': (w, p) => {
    if (!w.length) return w;
    const span = Math.max(1, Math.min(int(p.span, 1), w.length)), times = Math.max(2, int(p.times, 8));
    const at = Math.min(w.length - span, Math.max(0, Math.floor((Math.min(100, Math.max(0, int(p.at, 0))) / 100) * w.length)));
    const out = w.slice(0, at), run = w.slice(at, at + span);
    for (let t = 0; t < times; t++) for (const x of run) out.push(x);
    for (let i = at + span; i < w.length; i++) out.push(w[i]);
    return out;
  },
  'mosh.stride': (w, p) => {
    const every = Math.max(2, int(p.every, 3)), offset = Math.max(0, int(p.offset, 0)) % every, inv = (p.invert ?? 0) >= 0.5;
    const out = w.filter((_, i) => (inv ? i % every !== offset : i % every === offset));
    return out.length ? out : w.slice(0, 1);
  },
  'mosh.reverse': (w, p) => {
    const size = Math.max(0, int(p.chunk, 0));
    if (size < 2) return w.slice().reverse();
    const out: number[] = [];
    for (let i = 0; i < w.length; i += size) for (let j = Math.min(i + size, w.length) - 1; j >= i; j--) out.push(w[j]);
    return out;
  },
  'mosh.pingpong': (w, p) => {
    if (w.length < 2) return w;
    const laps = Math.max(1, int(p.laps, 1)), pause = Math.max(0, int(p.pause, 0));
    const rev = w.slice().reverse(), back = (p.doubleEnds ?? 0) >= 0.5 ? rev : rev.slice(1, -1);
    const out: number[] = [];
    for (let l = 0; l < laps; l++) {
      for (const x of w) out.push(x);
      for (let i = 0; i < pause; i++) out.push(w[w.length - 1]);
      for (const x of back) out.push(x);
      for (let i = 0; i < pause; i++) out.push(w[0]);
    }
    return out;
  },
  'mosh.stride-slip': (w, p) => {
    if (!w.length) return w;
    const every = Math.max(2, int(p.every, 3)), offset = Math.max(0, int(p.offset, 0)) % every;
    let last = w[0];
    return w.map((x, i) => { if (i % every === offset) last = x; return last; });
  },
  'mosh.speed': (w, p) => {
    if (!w.length) return w;
    const rate = Math.max(10, Math.min(400, int(p.rate, 100))), n = w.length, len = Math.max(1, Math.round((n * 100) / rate));
    return Array.from({ length: len }, (_, j) => w[Math.min(n - 1, Math.floor((j * rate) / 100))]);
  },
  'mosh.speed-ramp': (w, p) => {
    if (!w.length) return w;
    const a = Math.max(10, Math.min(400, int(p.rateIn, 100))), b = Math.max(10, Math.min(400, int(p.rateOut, 100))), n = w.length;
    const len = Math.max(1, Math.round((200 * n) / (a + b)));
    return Array.from({ length: len }, (_, j) => w[Math.min(n - 1, Math.max(0, Math.floor((j * a) / 100 + ((b - a) * j * j) / (200 * len))))]);
  },
};

/** Apply one op to a block's list, inside its window. */
export function applyBitstreamOp(kindKey: string, list: number[], p: Record<string, number>): number[] {
  const f = TRANSFORMS[kindKey];
  if (!f) return list;
  const [a, b] = windowOf(list.length, p);
  return [...list.slice(0, a), ...f(list.slice(a, b), p), ...list.slice(b)];
}
