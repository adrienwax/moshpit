// M5 audio-mirror MVP (tech research §4, L27): over each clip's own audio, three always-present
// parallel wet sends — gate/stutter (Bitstream), bitcrusher (Degrade), filter sweep (Tone) — all
// dry by default, their wet automated on over the blocks where the mapped video family is active,
// with 10 ms ramps at the edges. The dry path never passes through an effect, so it has no latency.
//
// Plain JavaScript over PCM rather than Tone.js / OfflineAudioContext: the same maths on every
// machine and Chromium version (L30's byte-identical export depends on it), testable in Node, and
// streamed in chunks so an hour of audio never sits in one buffer (§6). Every time is a sample
// index from the frame clock (L28); nothing is scheduled in milliseconds.

import * as fs from 'node:fs';
import type { Block, EffectFamily } from '@moshpit/core';
import { DEF_BY_KIND } from '../nodes/defs';
import { inlineContainers } from '../graph/container';
import { AudioClock, RationalClock } from '../time/clock';
import type { BlockSpan } from '../timeline/stage1';
import type { Rational } from '@moshpit/core';

export type Send = 'gate' | 'crush' | 'filter';
export const SENDS: Send[] = ['gate', 'crush', 'filter'];
/** The MVP mapping table: one send per mapped family. The other families are the fuller table, later. */
export const FAMILY_SEND: Partial<Record<EffectFamily, Send>> = { Bitstream: 'gate', Degrade: 'crush', Tone: 'filter' };
export const RAMP = 480; // 10 ms at 48 kHz

/** Wet automation: [start, end) in samples at `amount`, ramped over RAMP at each edge. */
export interface Lane { send: Send; start: number; end: number; amount: number }

/**
 * Walk the timeline: each block repetition turns on the send of every mapped family present in its
 * graph (bypassed nodes do not count). A motion block is itself a mosh, so it is Bitstream.
 */
export function lanesFor(spans: BlockSpan[], blocks: Block[], fps: Rational, rate: number): Lane[] {
  const clock = new AudioClock(new RationalClock(fps), rate);
  const out: Lane[] = [];
  for (const s of spans) {
    const b = blocks.find((x) => x.id === s.blockId);
    if (!b || b.audio.mute) continue;
    const amount = Math.max(0, Math.min(1, b.audio.mirror ?? 1));
    if (amount === 0) continue;
    const fams = new Set<EffectFamily>();
    if (b.kind === 'motion') fams.add('Bitstream');
    for (const n of inlineContainers(b.graph).graph.nodes) { const d = DEF_BY_KIND.get(n.kind); if (d?.family && !n.bypass) fams.add(d.family); }
    for (const f of fams) { const send = FAMILY_SEND[f]; if (send) out.push({ send, start: clock.sample(s.start), end: clock.sample(s.end), amount }); }
  }
  return out;
}

/** Streaming processor: feed consecutive chunks; output depends only on absolute sample positions. */
export class Mirror {
  private readonly period: number;     // stutter period: a 16th note at the project tempo
  private ring: Float32Array[];        // history for the stutter's buffer-repeat
  private crushHold = [0, 0];
  private bq = [new Float64Array(4), new Float64Array(4)]; // biquad x1 x2 y1 y2 per channel
  private c = new Float64Array(5);     // b0 b1 b2 a1 a2
  private readonly bySend: Record<Send, Lane[]>;
  private wet: Record<Send, Float32Array> = { gate: new Float32Array(0), crush: new Float32Array(0), filter: new Float32Array(0) };

  constructor(lanes: Lane[], private rate: number, private bpm: number) {
    this.period = Math.max(64, Math.round((rate * 60) / bpm / 4));
    this.ring = [new Float32Array(this.period * 4), new Float32Array(this.period * 4)];
    this.bySend = { gate: [], crush: [], filter: [] };
    for (const l of lanes) this.bySend[l.send].push(l);
  }

  /** True when no send is ever wet: the output is the input, untouched. */
  get dry(): boolean { return SENDS.every((s) => this.bySend[s].length === 0); }

  private fillWet(send: Send, at: number, n: number): Float32Array {
    let w = this.wet[send];
    if (w.length < n) w = this.wet[send] = new Float32Array(n);
    w.fill(0, 0, n);
    for (const l of this.bySend[send]) {
      const a = Math.max(at, l.start - RAMP), b = Math.min(at + n, l.end + RAMP);
      for (let i = a; i < b; i++) {
        const ramp = Math.min(1, (i - l.start + RAMP) / RAMP, (l.end + RAMP - i) / RAMP);
        const v = l.amount * Math.max(0, ramp);
        if (v > w[i - at]) w[i - at] = v;
      }
    }
    return w;
  }

  private laneAt(send: Send, i: number): Lane | null {
    for (const l of this.bySend[send]) if (i >= l.start - RAMP && i < l.end + RAMP) return l;
    return null;
  }

  /** Process channels in place. `at` is the absolute sample index of ch[0][0]. */
  process(ch: Float32Array[], at: number): void {
    const n = ch[0].length, P = this.period, H = P * 4;
    const wg = this.fillWet('gate', at, n), wc = this.fillWet('crush', at, n), wf = this.fillWet('filter', at, n);
    const spb = (this.rate * 60) / this.bpm;
    for (let i = 0; i < n; i++) {
      const abs = at + i;
      // Filter coefficients every 32 samples, from the absolute position: chunking cannot change them.
      if (abs % 32 === 0) {
        const barPhase = (abs / (spb * 4)) % 1;
        const fc = 300 * Math.pow(8000 / 300, 0.5 + 0.5 * Math.cos(2 * Math.PI * barPhase)); // 8 kHz → 300 Hz → 8 kHz per bar
        const w0 = (2 * Math.PI * fc) / this.rate, alpha = Math.sin(w0) / (2 * 0.9), cs = Math.cos(w0), a0 = 1 + alpha;
        this.c[0] = (1 - cs) / 2 / a0; this.c[1] = (1 - cs) / a0; this.c[2] = (1 - cs) / 2 / a0; this.c[3] = (-2 * cs) / a0; this.c[4] = (1 - alpha) / a0;
      }
      const gl = wg[i] > 0 ? this.laneAt('gate', abs) : null;
      for (let c = 0; c < ch.length && c < 2; c++) {
        const x = ch[c][i], ring = this.ring[c];
        ring[abs % H] = x;
        let y = x;
        // Gate/stutter: buffer-repeat the first 16th of every bar-quarter group, gated open 75 % of each period.
        if (gl !== null) {
          const rel = abs - gl.start, phase = ((rel % P) + P) % P, group = gl.start + Math.floor(rel / (4 * P)) * 4 * P;
          const src = Math.max(group + phase, abs - H + 1);
          const open = phase < P * 0.75 ? Math.min(1, phase / 96, (P * 0.75 - phase) / 96) : 0;
          y += wg[i] * (ring[((src % H) + H) % H] * open - x);
        }
        // Bitcrusher: 4-bit levels, sample-and-hold at a 6 kHz rate (hold by absolute index).
        if (abs % 8 === 0) this.crushHold[c] = Math.round(x * 8) / 8;
        if (wc[i] > 0) y += wc[i] * (this.crushHold[c] - x);
        // Filter sweep: a resonant low-pass whose state runs always, so switching it on never clicks.
        const s = this.bq[c], k = this.c;
        const f = k[0] * x + k[1] * s[0] + k[2] * s[1] - k[3] * s[2] - k[4] * s[3];
        s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = f;
        if (wf[i] > 0) y += wf[i] * (f - x);
        ch[c][i] = y < -1 ? -1 : y > 1 ? 1 : y;
      }
    }
  }
}

// ── WAV (16-bit PCM) streaming ──

interface WavInfo { channels: number; rate: number; dataOffset: number; dataBytes: number }

export function readWavInfo(fd: number): WavInfo {
  const head = Buffer.alloc(4096);
  const got = fs.readSync(fd, head, 0, head.length, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, channels = 0, rate = 0, bits = 0;
  while (o + 8 <= got) {
    const id = head.toString('ascii', o, o + 4), size = head.readUInt32LE(o + 4);
    if (id === 'fmt ') { channels = head.readUInt16LE(o + 10); rate = head.readUInt32LE(o + 12); bits = head.readUInt16LE(o + 22); }
    if (id === 'data') { if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}`); return { channels, rate, dataOffset: o + 8, dataBytes: size }; }
    o += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

export function wavHeader(channels: number, rate: number, dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Run the mirror over a 16-bit WAV, in chunks of `chunk` frames. Returns the frames processed. */
export function mirrorWav(inFile: string, outFile: string, lanes: Lane[], bpm: number, chunk = 48000): number {
  const fi = fs.openSync(inFile, 'r');
  const fo = fs.openSync(outFile, 'w');
  try {
    const w = readWavInfo(fi);
    const m = new Mirror(lanes, w.rate, bpm);
    fs.writeSync(fo, wavHeader(w.channels, w.rate, w.dataBytes));
    const frameBytes = w.channels * 2, total = Math.floor(w.dataBytes / frameBytes);
    const buf = Buffer.alloc(chunk * frameBytes);
    const ch = Array.from({ length: w.channels }, () => new Float32Array(chunk));
    for (let at = 0; at < total; at += chunk) {
      const n = Math.min(chunk, total - at);
      fs.readSync(fi, buf, 0, n * frameBytes, w.dataOffset + at * frameBytes);
      const view = ch.map((c) => c.subarray(0, n));
      for (let i = 0; i < n; i++) for (let c = 0; c < w.channels; c++) view[c][i] = buf.readInt16LE((i * w.channels + c) * 2) / 32768;
      m.process(view, at);
      for (let i = 0; i < n; i++) for (let c = 0; c < w.channels; c++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(view[c][i] * 32768))), (i * w.channels + c) * 2);
      fs.writeSync(fo, buf, 0, n * frameBytes);
    }
    return total;
  } finally { fs.closeSync(fi); fs.closeSync(fo); }
}
