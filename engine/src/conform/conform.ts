// L29: conform is a first-class, versioned, hashed artifact. Importing a clip produces a
// ConformedSource record; the conformed file lives in the disposable cache and rebuilds from
// the recorded arguments. Reopening re-conforms and compares `conformedHash` (D7).
//
// The recipe (verification sweep + clean-GPU probes):
//   Main profile (-profile:v main; Moshpit 1's recipe made High, which the slice layer refuses),
//   no B-frames, closed GOP, POC type 2 (x264's choice with -bf 0), ONE reference frame
//   (-refs 1: the default 3 crashes reverse/stride), fixed GOP of 120 with no scene-cut IDRs
//   (decision 1), `stitchable` headers and pinned colour tags so every clip conformed with the
//   same settings has byte-identical SPS/PPS and blocks can be spliced, audio kept as 48 kHz AAC.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MoshpitError } from '../errors';
import type { ConformedSource, SourceProbe, ChannelLayout, Rational, ConformId, SourceId } from '../model';
import { newId, CONFORM_QUALITIES, DEFAULT_CONFORM_QUALITY, type ConformQuality } from '@moshpit/core';
import { parseRational, rationalString } from '../time/clock';
import { demux, openSamples, type Mp4Video } from '../bitstream/mp4';
import { checkMoshable } from '../bitstream/h264';
import { ffmpegVersion, findFfmpeg, run } from './ffmpeg';

import { CONFORM_VERSION } from './version';
import { conformLevel } from './level';
export { CONFORM_VERSION };
export const CONFORM_GOP = 120;
export const AUDIO_RATE = 48000;

/** Codecs ffmpeg decodes that we accept on import. Anything else is refused with a clear code. */
export const SUPPORTED_INPUT_CODECS = [
  'h264', 'hevc', 'av1', 'vp8', 'vp9', 'prores', 'dnxhd', 'mpeg4', 'mpeg2video', 'mjpeg', 'wmv2', 'wmv3', 'vc1',
  'apv', 'qtrle', 'png', 'rawvideo', 'cfhd', 'hap', 'theora', 'msmpeg4v3', 'h263', 'flv1',
] as const;

const HDR_TRANSFERS = ['arib-std-b67', 'smpte2084'];

export interface ConformSettings {
  fps: Rational;
  width: number;
  height: number;
  /** Proxy divisor (decision 2). 4 → 480×270 at 1080p. */
  proxyDivisor: number;
  crf: number;
  /** Speed ↔ smoothness (CONFORM_QUALITIES). Part of the cache key and the record. Default balanced. */
  quality?: ConformQuality;
  ffmpeg?: string;
  /** Conform only this slice of the file (Use with IN/OUT). In the args, so in the cache key. */
  range?: { startSec: number; durSec: number };
}

export async function probe(file: string, ffmpegPath?: string): Promise<SourceProbe> {
  if (!fs.existsSync(file)) throw new MoshpitError('MEDIA_FILE_MISSING', { path: file });
  const { ffprobe } = findFfmpeg(ffmpegPath);
  let out;
  try { out = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]); }
  catch (e) { throw e instanceof MoshpitError ? e : new MoshpitError('MEDIA_UNREADABLE', { path: file }, e); }
  const j = JSON.parse(out.stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new MoshpitError('MEDIA_UNREADABLE', { path: file, reason: 'no video stream' });
  const a = j.streams.find((s: any) => s.codec_type === 'audio');
  const rot = v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? (v.tags?.rotate ? +v.tags.rotate : undefined);
  const channels = a ? +a.channels : 0;
  const layout: ChannelLayout = channels === 1 ? 'mono' : channels === 6 ? '5.1' : 'stereo';
  return {
    codec: v.codec_name, width: +v.width, height: +v.height,
    fps: v.r_frame_rate && v.r_frame_rate !== '0/0' ? parseRational(v.r_frame_rate) : { num: 30, den: 1 },
    durationSec: +(v.duration ?? j.format.duration ?? 0), frames: v.nb_frames ? +v.nb_frames : undefined,
    pixFmt: v.pix_fmt ?? 'unknown', hasAlpha: /^(yuva|rgba|argb|bgra|abgr|gbrap|ya)/.test(v.pix_fmt ?? ''),
    transfer: v.color_transfer, rotation: rot,
    audio: a ? { type: 'AudioBuffer', codec: a.codec_name, sampleRate: +a.sample_rate, channels, layout } : undefined,
  };
}

/** The exact arguments, so the record can say what was run and a reviewer can rerun it. */
export function conformArgs(input: string, output: string, p: SourceProbe, s: ConformSettings, proxy: boolean): string[] {
  const w = proxy ? even(s.width / s.proxyDivisor) : s.width;
  const h = proxy ? even(s.height / s.proxyDivisor) : s.height;
  const vf: string[] = [];
  if (p.transfer && HDR_TRANSFERS.includes(p.transfer)) {
    vf.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  // Letterbox, never crop: the conform must not throw picture away (Moshpit 1 pads too).
  vf.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease:out_color_matrix=bt709:out_range=tv:flags=bicubic`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1', `fps=${rationalString(s.fps)}`, 'format=yuv420p',
    // E12: stamp the tags on the frames. The -color_* output flags below lose to the decoded
    // frame's own properties, so an untagged source kept "unknown" and a BT.709 one kept bt709,
    // and the two SPSs could not be spliced.
    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  // A slice: input-side seek (fast) then a duration. The re-encode makes the cut frame-exact.
  const cut = s.range ? ['-ss', s.range.startSec.toFixed(6), '-t', s.range.durSec.toFixed(6)] : [];
  const args = ['-hide_banner', '-nostdin', '-y', ...cut, '-i', input, '-map', '0:v:0', '-vf', vf.join(','),
    // Master preset from the quality (balanced = veryfast: 1.9× medium at the same size, within 1 dB).
    // chroma-qp-offset=-2 is what medium's psy-rd writes into the PPS; pinning it on the presets
    // without psy-rd keeps SPS/PPS byte-identical across qualities and to earlier conforms.
    // The proxy is the same at every quality: proxies splice with proxies.
    '-c:v', 'libx264', '-preset', proxy ? 'veryfast' : x264Preset(s.quality), '-crf', String(proxy ? 23 : s.crf),
    '-profile:v', 'main', '-level:v', conformLevel(w, h, s.fps), '-bf', '0', '-refs', '1', '-flags:v', '+cgop',
    '-g', String(CONFORM_GOP), '-keyint_min', String(CONFORM_GOP), '-sc_threshold', '0',
    // threads pinned: x264 output depends on thread count, and D7 compares hashes across reopen.
    '-x264-params', proxy ? 'stitchable=1:threads=8' : `stitchable=1:threads=8${PSY_RD_PRESETS.has(x264Preset(s.quality)) ? '' : ':chroma-qp-offset=-2'}`,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  if (!proxy && p.audio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', String(Math.min(2, p.audio.channels)));
  else args.push('-an');
  args.push('-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1', '-movflags', '+faststart', output);
  return args;
}

/** Presets whose psy-rd already lowers the PPS chroma QP offset by 2; the others get it pinned. */
const PSY_RD_PRESETS = new Set(['medium']); // measured; a new preset goes here only once the quality test passes

export function x264Preset(q: ConformQuality = DEFAULT_CONFORM_QUALITY): string {
  const hit = CONFORM_QUALITIES.find((c) => c.id === q);
  if (!hit) throw new MoshpitError('INTERNAL', { why: `unknown conform quality ${q}` });
  return hit.x264;
}

const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

/**
 * sha256 of the video bitstream: avcC + every sample's bytes. Container metadata never enters it.
 * Phase 0.1b: it yields every ~10 ms. A 60 s 1080p master read and hashed in one go blocked the
 * worker thread for hundreds of ms; the bytes and the digest are exactly the same.
 */
export async function bitstreamHash(v: Mp4Video): Promise<string> {
  const h = crypto.createHash('sha256');
  h.update(v.avcC);
  const r = openSamples(v);
  try {
    let t = performance.now();
    for (let i = 0; i < v.samples.length; i++) {
      h.update(r.view(i));
      if (performance.now() - t > 10) {
        await new Promise((res) => setTimeout(res, 0));
        t = performance.now();
      }
    }
  } finally { r.close(); }
  return h.digest('hex');
}

/** Sampled content hash of a source file: size + three 1 MB blocks. Relink identity, not integrity. */
export function sourceHash(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, h = crypto.createHash('sha256'), buf = Buffer.alloc(1 << 20);
    h.update(String(size));
    for (const at of [0, Math.max(0, Math.floor(size / 2) - (1 << 19)), Math.max(0, size - (1 << 20))]) h.update(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, at)));
    return h.digest('hex');
  } finally { fs.closeSync(fd); }
}

export interface ConformResult {
  record: ConformedSource;
  video: Mp4Video;
}

/** One conform's identity and paths, shared by its two stages. */
interface ConformJob {
  file: string; s: ConformSettings; p: SourceProbe; sh: string; ffv: string; ffmpeg: string; quality: ConformQuality;
  out: string; proxyOut: string; side: string; proxySide: string; notes: string[]; totalFrames: number;
}

async function prepare(file: string, s: ConformSettings, cacheDir: string): Promise<ConformJob> {
  const p = await probe(file, s.ffmpeg);
  if (!(SUPPORTED_INPUT_CODECS as readonly string[]).includes(p.codec)) throw new MoshpitError('DECODE_UNSUPPORTED_CODEC', { path: file, codec: p.codec });
  const { ffmpeg } = findFfmpeg(s.ffmpeg);
  const sh = sourceHash(file);
  fs.mkdirSync(cacheDir, { recursive: true });
  const quality = s.quality ?? DEFAULT_CONFORM_QUALITY;
  const ffv = await ffmpegVersion(ffmpeg);
  // The cache key is everything that shapes the output bytes: the source's content, the ffmpeg
  // build, and both argument lists (paths left out, so the same clip anywhere on disk reuses it).
  // Quality, CRF, size, rate, proxy divisor and CONFORM_VERSION are all inside the args.
  const recipe = crypto.createHash('sha256').update(JSON.stringify([CONFORM_VERSION, sh, ffv, conformArgs('IN', 'OUT', p, s, false), conformArgs('IN', 'OUT', p, s, true)])).digest('hex');
  const stem = path.join(cacheDir, `${sh.slice(0, 16)}-${quality}-${s.width}x${s.height}-${recipe.slice(0, 12)}`);
  const notes: string[] = [];
  if (p.transfer && HDR_TRANSFERS.includes(p.transfer)) notes.push('HDR_TONEMAPPED');
  if (p.hasAlpha) notes.push('ALPHA_DROPPED');
  return {
    file, s, p, sh, ffv, ffmpeg, quality, notes,
    out: `${stem}.mp4`, proxyOut: `${stem}-proxy.mp4`, side: `${stem}.json`, proxySide: `${stem}.proxy.json`,
    totalFrames: Math.max(1, Math.round(((s.range?.durSec ?? p.durationSec) * s.fps.num) / s.fps.den)),
  };
}

export interface StageOptions {
  /** False forces a fresh encode (D7's re-check). Default true. */
  reuse?: boolean;
  onProgress?: (frac: number) => void;
  signal?: AbortSignal;
  /** Run the encoder below normal priority, so a background master never stutters the UI. */
  background?: boolean;
}

/**
 * A finished stage's record from its sidecar, if both it and its files exist. The sidecar's paths
 * are absolute from when it was written; `files` are where they are now (the cache dir can move,
 * as it did out of Chromium's "Cache"), so each path is taken from the file actually found.
 */
export function reused(side: string, files: string[], sourceId: SourceId): ConformedSource | null {
  if (!fs.existsSync(side) || !files.every((f) => fs.existsSync(f))) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(side, 'utf8')) as ConformedSource;
    const here = (p: string) => files.find((f) => path.basename(f) === path.basename(p)) ?? p;
    const proxy = rec.proxy && { ...rec.proxy, path: here(rec.proxy.path) };
    return { ...rec, path: here(rec.path), proxy, id: newId<ConformId>(), sourceId, notes: [...rec.notes.filter((n) => n !== 'REUSED'), 'REUSED'] };
  } catch { return null; } // unreadable sidecar: encode again
}

/** Sidecars are written last and atomically: one existing means its files were complete. */
function writeSidecar(side: string, rec: ConformedSource): void {
  const tmp = `${side}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  try { fs.renameSync(tmp, side); } catch { fs.rmSync(tmp, { force: true }); }
}

/**
 * Encode one output under a unique name and move it into place: two conforms of one clip at once
 * (two imports, parallel test workers) used to write the same file and leave a corrupt master.
 * The output is deterministic, so whichever copy lands first is the right one.
 */
async function encode(job: ConformJob, proxy: boolean, o: StageOptions): Promise<void> {
  const final = proxy ? job.proxyOut : job.out;
  const tmp = final.replace(/\.mp4$/, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}.mp4`);
  const progress = (line: string) => { const m = /frame=\s*(\d+)/.exec(line); if (m && o.onProgress) o.onProgress(Math.min(1, +m[1] / job.totalFrames)); };
  try {
    await run(job.ffmpeg, conformArgs(job.file, tmp, job.p, job.s, proxy), { onStderr: progress, signal: o.signal, background: o.background });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if ((e as Error)?.name === 'AbortError') throw e;
    throw e instanceof MoshpitError ? e : new MoshpitError('CONFORM_FAILED', { path: job.file, stderr: (e as { stderr?: string }).stderr?.slice(-2000) }, e);
  }
  if (fs.existsSync(final)) { fs.rmSync(tmp, { force: true }); return; }
  try { fs.renameSync(tmp, final); } catch { fs.rmSync(tmp, { force: true }); if (!fs.existsSync(final)) throw new MoshpitError('CONFORM_FAILED', { path: job.file, reason: 'could not move the conform into the cache' }); }
}

/**
 * Stage 1 of proxy-first import: the keyframe-locked proxy only (~1/4 of a full Balanced conform).
 * The record has `status: 'proxy'`: frames, keyframes and the planned master path are final (the
 * proxy shares every frame index and IDR with the master, decision 2); the master's hash and audio
 * are not known yet. Browse, slice and mosh preview run on it. If the full conform is already
 * cached, this returns the ready record instead.
 */
export async function conformProxy(sourceId: SourceId, file: string, s: ConformSettings, cacheDir: string, o: StageOptions = {}): Promise<ConformedSource> {
  const job = await prepare(file, s, cacheDir);
  if (o.reuse !== false) {
    const hit = reused(job.side, [job.out, job.proxyOut], sourceId) ?? reused(job.proxySide, [job.proxyOut], sourceId);
    if (hit) { o.onProgress?.(1); return hit; }
  }
  await encode(job, true, o);
  const proxy = demux(job.proxyOut);
  const notes = [...job.notes];
  try { checkMoshable(proxy.avcC); } catch { notes.push('CONFORM_NOT_MOSHABLE'); }
  const rec: ConformedSource = {
    id: newId<ConformId>(), sourceId, sourceHash: job.sh, ...(s.range ? { range: s.range } : {}), conformVersion: CONFORM_VERSION, quality: job.quality, status: 'proxy',
    args: conformArgs(file, job.out, job.p, s, false), ffmpegVersion: job.ffv,
    path: job.out, codecString: proxy.codecString, profile: 'main', pocType: 2, refs: 1, gop: CONFORM_GOP, fps: proxy.fps,
    width: s.width, height: s.height, frames: proxy.samples.length, keyframes: proxy.keyframes,
    frameNumBits: proxy.sps?.frameNumBits ?? 0, conformedHash: '',
    proxy: { path: job.proxyOut, width: proxy.width, height: proxy.height, conformedHash: await bitstreamHash(proxy) },
    moshable: !notes.includes('CONFORM_NOT_MOSHABLE'), notes, createdAt: new Date().toISOString(),
  };
  writeSidecar(job.proxySide, rec);
  return rec;
}

/**
 * Stage 2: the full-quality master for a proxy-stage record. Checks it is keyframe-locked to the
 * proxy the user has been editing on and returns the ready record (`status: 'ready'`). The
 * master's bytes are exactly what a one-shot conform writes: determinism does not depend on order.
 */
export async function conformMaster(rec: ConformedSource, file: string, s: ConformSettings, cacheDir: string, o: StageOptions = {}): Promise<ConformResult> {
  const job = await prepare(file, s, cacheDir);
  if (o.reuse !== false) {
    const done = reused(job.side, [job.out, job.proxyOut], rec.sourceId);
    if (done) { o.onProgress?.(1); return { record: { ...done, id: rec.id }, video: demux(job.out) }; }
  }
  if (!rec.proxy || !fs.existsSync(rec.proxy.path)) throw new MoshpitError('CONFORM_FAILED', { path: file, reason: 'the proxy this master belongs to is missing' });
  await encode(job, false, o);
  const video = demux(job.out), proxy = demux(rec.proxy.path);
  const notes = rec.notes.filter((n) => n !== 'REUSED');
  try { checkMoshable(video.avcC); } catch { if (!notes.includes('CONFORM_NOT_MOSHABLE')) notes.push('CONFORM_NOT_MOSHABLE'); }
  // Decision 2 depends on this: the proxy must share every frame index and every IDR position.
  if (proxy.samples.length !== video.samples.length || proxy.keyframes.join() !== video.keyframes.join()) {
    throw new MoshpitError('CONFORM_FAILED', { path: file, reason: 'proxy not keyframe-locked', master: video.samples.length, proxy: proxy.samples.length });
  }
  const record: ConformedSource = {
    ...rec, status: 'ready', path: job.out, codecString: video.codecString, fps: video.fps,
    width: video.width, height: video.height, frames: video.samples.length, keyframes: video.keyframes,
    frameNumBits: video.sps?.frameNumBits ?? 0, conformedHash: await bitstreamHash(video),
    audio: video.audio ? { sampleRate: video.audio.sampleRate, channels: video.audio.channels, layout: video.audio.channels === 1 ? 'mono' : 'stereo', codec: video.audio.codec, samples: video.audio.samples } : undefined,
    moshable: !notes.includes('CONFORM_NOT_MOSHABLE'), notes,
  };
  writeSidecar(job.side, { ...record, notes: notes.filter((n) => n !== 'REUSED') });
  return { record, video };
}

/**
 * Conform one source in one call: proxy, then master. Returns the ready record. Never overwrites
 * a source (rule 5). `onProgress` reports each stage's own fraction.
 */
export async function conform(sourceId: SourceId, file: string, s: ConformSettings, cacheDir: string, onProgress?: (frac: number, stage: 'proxy' | 'master') => void, o: { reuse?: boolean; signal?: AbortSignal } = {}): Promise<ConformResult> {
  const rec = await conformProxy(sourceId, file, s, cacheDir, { reuse: o.reuse, signal: o.signal, onProgress: (f) => onProgress?.(f, 'proxy') });
  if (rec.status !== 'proxy') return { record: rec, video: demux(rec.path) }; // the full conform was cached
  return conformMaster(rec, file, s, cacheDir, { reuse: o.reuse, signal: o.signal, onProgress: (f) => onProgress?.(f, 'master') });
}

/** D7: on reopen, compare a fresh conform with the pinned record. Mismatch keeps the pinned one. */
export function conformDiverged(pinned: ConformedSource, fresh: ConformedSource): boolean {
  return pinned.conformedHash !== fresh.conformedHash;
}
