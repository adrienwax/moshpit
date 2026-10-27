// SOURCE: lazy mp4 demux. Ported from the spike's `demuxLazy`: keep only the sample table
// (offset, size, sync) and read a sample's bytes from disk when it is needed. A 20-minute 1080p
// clip is gigabytes; the eager path held it in RAM twice.
//
// Node `fs`: runs in the render worker (nodeIntegration) and in tests, never in the UI renderer.

import * as fs from 'node:fs';
import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box';
import { MoshpitError } from '../errors';
import { rational } from '../time/clock';
import type { Rational } from '@moshpit/core';
import { checkMoshable, type SpsInfo } from './h264';

export interface SampleRef {
  off: number;
  size: number;
  key: boolean;
}

export interface Mp4Video {
  path: string;
  codecString: string;
  width: number;
  height: number;
  fps: Rational;
  /** avcC payload: the WebCodecs `description`. */
  avcC: Uint8Array;
  samples: SampleRef[];
  keyframes: number[];
  sps: SpsInfo | null;
  audio: { codec: string; sampleRate: number; channels: number; samples: number } | null;
}

export interface SampleReader {
  /** The reused read-ahead buffer. Contents valid until the next locate or view. */
  readonly buf: Uint8Array;
  /** Make sample i resident in `buf` and return its offset. One disk read per 4 MB window (L21). */
  locate(i: number): number;
  /** A view of sample i: valid until the next call. Copy what you keep. */
  view(i: number): Uint8Array;
  copy(i: number): Uint8Array;
  close(): void;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export function demux(path: string, opts: { requireMoshable?: boolean } = {}): Mp4Video {
  if (!fs.existsSync(path)) throw new MoshpitError('MEDIA_FILE_MISSING', { path });
  const fd = fs.openSync(path, 'r');
  try {
    const f = createFile();
    let info: any = null, err: unknown = null;
    f.onError = (_m: string, e: string) => { err = e; };
    f.onReady = (i: any) => { info = i; };
    const size = fs.fstatSync(fd).size;
    const CH = 8 << 20;
    let pos = 0;
    while (!info && !err && pos < size) {
      const buf = Buffer.alloc(Math.min(CH, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      const ab = MP4BoxBuffer.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n), pos);
      const next = f.appendBuffer(ab);
      pos = next > pos ? next : pos + n;
    }
    if (err || !info) throw new MoshpitError('MEDIA_UNREADABLE', { path, reason: String(err ?? 'no moov box') });
    const track = info.videoTracks[0];
    if (!track) throw new MoshpitError('MEDIA_UNREADABLE', { path, reason: 'no video track' });
    if (!String(track.codec).startsWith('avc1')) throw new MoshpitError('DECODE_UNSUPPORTED_CODEC', { path, codec: track.codec });
    const trak: any = f.getTrackById(track.id);
    let avcC: Uint8Array | null = null;
    for (const e of trak.mdia.minf.stbl.stsd.entries) {
      if (!e.avcC) continue;
      const ds = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      e.avcC.write(ds);
      avcC = new Uint8Array(ds.buffer, 8); // skip the box header
    }
    if (!avcC) throw new MoshpitError('MEDIA_UNREADABLE', { path, reason: 'no avcC' });
    const table = trak.samples as { offset: number; size: number; is_sync: boolean; timescale: number; duration: number }[];
    const samples = table.map((x) => ({ off: x.offset, size: x.size, key: x.is_sync }));
    const k = gcd(table[0].timescale, table[0].duration);
    const fps = rational(table[0].timescale / k, table[0].duration / k);
    let sps: SpsInfo | null = null;
    try { sps = checkMoshable(avcC); } catch (e) { if (opts.requireMoshable) throw e; }
    const at = info.audioTracks?.[0];
    return {
      path, codecString: track.codec, width: track.video.width, height: track.video.height, fps, avcC, samples,
      keyframes: samples.flatMap((s, i) => (s.key ? [i] : [])), sps,
      audio: at ? { codec: at.codec, sampleRate: at.audio.sample_rate, channels: at.audio.channel_count, samples: Math.round((at.duration / at.timescale) * at.audio.sample_rate) } : null,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Samples sit nearly contiguous in mdat, so reading a window at a time turns one readSync per
 * frame (Node allocates ~190 B inside each call) into one per few hundred frames.
 */
export function openSamples(v: Mp4Video, windowBytes = 4 << 20): SampleReader {
  const fd = fs.openSync(v.path, 'r');
  let max = 0;
  for (const s of v.samples) if (s.size > max) max = s.size;
  const win = Math.max(windowBytes, max);
  const buf = new Uint8Array(win);
  let base = -1, len = 0;
  const locate = (i: number) => {
    const s = v.samples[i];
    if (base < 0 || s.off < base || s.off + s.size > base + len) { len = fs.readSync(fd, buf, 0, win, s.off); base = s.off; }
    return s.off - base;
  };
  return {
    buf, locate,
    view(i) { const o = locate(i); return buf.subarray(o, o + v.samples[i].size); },
    copy(i) { return this.view(i).slice(); },
    close() { fs.closeSync(fd); },
  };
}
