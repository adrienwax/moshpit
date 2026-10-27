// The H.264 slice-header layer (spike condition 1): just enough parsing to renumber `frame_num`
// so a stream with keyframes removed, P-frames reordered, or clips spliced end to end decodes
// with no frame withheld. Ported from the spike's engine.js, rewritten over typed arrays because
// the spike's array-push RBSP escape is far too slow for 1080p frames.
//
// Scope: Baseline/Main SPS, pic_order_cnt_type 2, AVCC length-prefixed samples (4-byte lengths).
// That is exactly what the conform produces (L29); anything else is refused, never guessed at.

import { MoshpitError } from '../errors';

let scratch = new Uint8Array(1 << 16);
const grow = (n: number) => { if (scratch.length < n) scratch = new Uint8Array(n * 2); };

/** Escaped NAL payload → RBSP (emulation-prevention bytes removed). Returns a fresh copy. */
export function unescapeRbsp(b: Uint8Array): Uint8Array {
  grow(b.length);
  let o = 0, z = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    if (z >= 2 && x === 3) { z = 0; continue; }
    scratch[o++] = x;
    z = x === 0 ? z + 1 : 0;
  }
  return scratch.slice(0, o);
}

/** RBSP → escaped NAL payload. */
export function escapeRbsp(b: Uint8Array): Uint8Array {
  grow(b.length + (b.length >> 1) + 4);
  let o = 0, z = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    if (z >= 2 && x <= 3) { scratch[o++] = 3; z = 0; }
    scratch[o++] = x;
    z = x === 0 ? z + 1 : 0;
  }
  return scratch.slice(0, o);
}

export class Bits {
  constructor(public b: Uint8Array, public p = 0) {}
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++, this.p++) v = (v << 1) | ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1);
    return v >>> 0;
  }
  ue(): number {
    let z = 0;
    while (this.u(1) === 0) { if (++z > 31) throw new MoshpitError('BITSTREAM_PROFILE_UNSUPPORTED', { reason: 'bad exp-golomb' }); }
    return (2 ** z) - 1 + this.u(z);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
  put(n: number, v: number): void {
    for (let i = n - 1; i >= 0; i--, this.p++) {
      const m = 1 << (7 - (this.p & 7));
      if ((v >> i) & 1) this.b[this.p >> 3] |= m; else this.b[this.p >> 3] &= ~m;
    }
  }
}

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

export interface SpsInfo {
  profileIdc: number;
  levelIdc: number;
  frameNumBits: number;
  pocType: number;
  maxRefFrames: number;
  gapsAllowed: boolean;
}

export function parseSps(nal: Uint8Array): SpsInfo {
  const sps = unescapeRbsp(nal);
  const profileIdc = sps[1], levelIdc = sps[3];
  if (HIGH_PROFILES.includes(profileIdc)) throw new MoshpitError('BITSTREAM_PROFILE_UNSUPPORTED', { profileIdc });
  const r = new Bits(sps, 32);
  r.ue(); // seq_parameter_set_id
  const frameNumBits = r.ue() + 4;
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  const maxRefFrames = r.ue();
  const gapsAllowed = r.u(1) === 1;
  return { profileIdc, levelIdc, frameNumBits, pocType, maxRefFrames, gapsAllowed };
}

/** avcC → its SPS and PPS NAL payloads (escaped, as stored). */
export function parseAvcC(avcC: Uint8Array): { sps: Uint8Array[]; pps: Uint8Array[]; lengthSize: number } {
  const lengthSize = (avcC[4] & 3) + 1;
  let o = 5;
  const sps: Uint8Array[] = [], pps: Uint8Array[] = [];
  const nSps = avcC[o++] & 31;
  for (let i = 0; i < nSps; i++) { const n = (avcC[o] << 8) | avcC[o + 1]; sps.push(avcC.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  const nPps = avcC[o++];
  for (let i = 0; i < nPps; i++) { const n = (avcC[o] << 8) | avcC[o + 1]; pps.push(avcC.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  return { sps, pps, lengthSize };
}

/**
 * The mosh contract a stream must meet before any encoded-domain op touches it (L29). Throws
 * BITSTREAM_PROFILE_UNSUPPORTED naming the clause that failed.
 */
export function checkMoshable(avcC: Uint8Array): SpsInfo {
  const { sps, lengthSize } = parseAvcC(avcC);
  if (lengthSize !== 4) throw new MoshpitError('BITSTREAM_PROFILE_UNSUPPORTED', { lengthSize });
  const info = parseSps(sps[0]);
  if (info.pocType !== 2) throw new MoshpitError('BITSTREAM_PROFILE_UNSUPPORTED', { pocType: info.pocType });
  if (info.maxRefFrames !== 1) throw new MoshpitError('BITSTREAM_PROFILE_UNSUPPORTED', { maxRefFrames: info.maxRefFrames, why: 'conform must use -refs 1; 3 refs crashes reverse/stride' });
  return info;
}

/** Two clips can be spliced in one encoded stream only if their parameter sets are byte-identical. */
export function sameParameterSets(a: Uint8Array, b: Uint8Array): boolean {
  const x = parseAvcC(a), y = parseAvcC(b);
  const eq = (p: Uint8Array[], q: Uint8Array[]) => p.length === q.length && p.every((u, i) => u.length === q[i].length && u.every((v, j) => v === q[i][j]));
  return eq(x.sps, y.sps) && eq(x.pps, y.pps);
}

/** Stage-1 compatibility for old/new conforms whose only difference is decoder capacity.
 * Main-profile level_idc is metadata, not slice syntax (FFmpeg's h264_metadata likewise changes
 * it without re-encoding). Choose an existing higher-level config, never lower its requirements.
 * Everything else in avcC, SPS and PPS stays byte-identical; no source bytes are modified.
 * Limit the exception to our generated levels and one SPS/PPS, excluding level-1b semantics. */
export function spliceParameterSets(a: Uint8Array, b: Uint8Array): Uint8Array | null {
  if (a.length !== b.length) return null;
  if (a.every((v, i) => v === b[i])) return a;
  const valid = (c: Uint8Array) => {
    if (c.length < 12 || c[0] !== 1 || c[1] !== 77 || ![41, 42, 50, 51, 52, 60].includes(c[3])) return false;
    const { sps, pps, lengthSize } = parseAvcC(c);
    return lengthSize === 4 && sps.length === 1 && pps.length === 1 && sps[0].length >= 4 && pps[0].length > 0
      && sps[0][0] === 0x67 && sps[0][1] === c[1] && sps[0][2] === c[2] && sps[0][3] === c[3];
  };
  if (!valid(a) || !valid(b)) return null;
  // The one SPS begins after the fixed eight-byte avcC prefix; its level is byte three.
  // Checking every other byte also preserves lengths, constraints, VUI and any trailing data.
  if (!a.every((v, i) => i === 3 || i === 11 || v === b[i])) return null;
  return a[3] >= b[3] ? a : b;
}

export interface SliceHeaderInfo {
  frameNum: number;
  nalRefIdc: number;
  idr: boolean;
}

/** Read frame_num and nal_ref_idc from the first slice of an AVCC sample. */
export function readSliceHeader(sample: Uint8Array, frameNumBits: number): SliceHeaderInfo {
  for (let o = 0; o + 4 <= sample.length;) {
    const len = ((sample[o] << 24) | (sample[o + 1] << 16) | (sample[o + 2] << 8) | sample[o + 3]) >>> 0;
    const nal = sample.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    const type = nal[0] & 31;
    if (type !== 1 && type !== 5) continue;
    // Only the header is needed; 64 escaped bytes covers it with room.
    const rb = unescapeRbsp(nal.subarray(0, Math.min(nal.length, 64)));
    const r = new Bits(rb, 8);
    r.ue(); r.ue(); r.ue(); // first_mb_in_slice, slice_type, pic_parameter_set_id
    return { frameNum: r.u(frameNumBits), nalRefIdc: (nal[0] >> 5) & 3, idr: type === 5 };
  }
  throw new MoshpitError('BITSTREAM_PROFILE_UNSUPPORTED', { reason: 'sample has no slice NAL' });
}

/**
 * Return a copy of `sample` with every slice's frame_num set to `frameNum`. Only the slice NALs
 * are re-escaped; SEI and anything else pass through as stored.
 */
export function writeFrameNum(sample: Uint8Array, frameNumBits: number, frameNum: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let o = 0; o + 4 <= sample.length;) {
    const len = ((sample[o] << 24) | (sample[o + 1] << 16) | (sample[o + 2] << 8) | sample[o + 3]) >>> 0;
    const nal = sample.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    const type = nal[0] & 31;
    if (type === 1 || type === 5) {
      const rb = unescapeRbsp(nal);
      const r = new Bits(rb, 8);
      r.ue(); r.ue(); r.ue();
      r.put(frameNumBits, frameNum);
      parts.push(escapeRbsp(rb));
    } else parts.push(nal);
  }
  let n = 0;
  for (const p of parts) n += 4 + p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out[o] = p.length >>> 24; out[o + 1] = p.length >>> 16; out[o + 2] = p.length >>> 8; out[o + 3] = p.length;
    out.set(p, o + 4);
    o += 4 + p.length;
  }
  return out;
}

/** AVCC sample → Annex-B, for handing a stream to ffmpeg as an independent decoder. */
export function toAnnexB(sample: Uint8Array): Uint8Array {
  const out = new Uint8Array(sample.length);
  out.set(sample);
  for (let o = 0; o + 4 <= out.length;) {
    const len = ((out[o] << 24) | (out[o + 1] << 16) | (out[o + 2] << 8) | out[o + 3]) >>> 0;
    out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 1;
    o += 4 + len;
  }
  return out;
}

export function annexBParameterSets(avcC: Uint8Array): Uint8Array {
  const { sps, pps } = parseAvcC(avcC);
  const nals = [...sps, ...pps];
  const out = new Uint8Array(nals.reduce((n, x) => n + 4 + x.length, 0));
  let o = 0;
  for (const x of nals) { out.set([0, 0, 0, 1], o); out.set(x, o + 4); o += 4 + x.length; }
  return out;
}

const hdrRaw = new Uint8Array(96);
const hdrEsc = new Uint8Array(160);
const hdrBits = new Bits(hdrRaw);

/**
 * L21 hot path: write `sample` with frame_num set into `out` without allocating, and return the
 * byte length. Only a short prefix of each slice NAL is unescaped and re-escaped: frame_num sits
 * in the first few bytes of the slice header, and the split point is chosen just after a non-zero
 * byte the edit cannot reach, so the emulation-prevention state at the join is unchanged and the
 * rest of the NAL is copied as stored. Falls back to `writeFrameNum` if no safe split exists.
 */
export function writeFrameNumInto(sample: Uint8Array, frameNumBits: number, frameNum: number, out: Uint8Array, length = sample.length, from = 0): number {
  let w = 0;
  const stop = from + length;
  for (let o = from; o + 4 <= stop;) {
    const len = ((sample[o] << 24) | (sample[o + 1] << 16) | (sample[o + 2] << 8) | sample[o + 3]) >>> 0;
    const start = o + 4, end = start + len;
    o = end;
    const type = sample[start] & 31;
    if (type !== 1 && type !== 5) { out.set(sample.subarray(start - 4, end), w); w += len + 4; continue; }
    // Find a split: an escaped index ≥ 16 whose byte is non-zero and not an emulation byte.
    let split = -1;
    for (let i = start + 16, z = 0, j = start; j < Math.min(end, start + 64); j++) {
      const x = sample[j];
      const emul = z >= 2 && x === 3;
      if (j >= i && x !== 0 && !emul) { split = j + 1; break; }
      z = emul ? 0 : x === 0 ? z + 1 : 0;
    }
    if (split < 0) { const full = writeFrameNum(sample.subarray(start - 4, end), frameNumBits, frameNum); out.set(full, w); w += full.length; continue; }
    // Unescape [start, split) → hdrRaw.
    let r = 0;
    for (let j = start, z = 0; j < split; j++) {
      const x = sample[j];
      if (z >= 2 && x === 3) { z = 0; continue; }
      hdrRaw[r++] = x;
      z = x === 0 ? z + 1 : 0;
    }
    hdrBits.p = 8;
    hdrBits.ue(); hdrBits.ue(); hdrBits.ue();
    hdrBits.put(frameNumBits, frameNum);
    // Re-escape the prefix.
    let e = 0;
    for (let j = 0, z = 0; j < r; j++) {
      const x = hdrRaw[j];
      if (z >= 2 && x <= 3) { hdrEsc[e++] = 3; z = 0; }
      hdrEsc[e++] = x;
      z = x === 0 ? z + 1 : 0;
    }
    const n = e + (end - split);
    out[w] = n >>> 24; out[w + 1] = n >>> 16; out[w + 2] = n >>> 8; out[w + 3] = n;
    out.set(hdrEsc.subarray(0, e), w + 4);
    out.set(sample.subarray(split, end), w + 4 + e);
    w += 4 + n;
  }
  return w;
}
