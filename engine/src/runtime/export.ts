// The File Render Sink (L16): authoritative export of a timeline range.
//
//   mp4-h264   pinned Chromium software H.264 encode (frames in are deterministic, the encoded bytes are not: encode.ts), muxed with the
//              assembled per-clip audio by ffmpeg with -c:v copy and bitexact flags
//   prores / hap / hap-alpha / hapq
//              raw RGBA piped into ffmpeg with Moshpit 2.0's presets (host/transcode.mjs), except
//              ProRes 422 HQ uses prores_aw: the verification sweep measured prores_ks at 8 fps
//              and prores_aw at 48 fps on the same footage
//   png-seq    numbered PNGs through ffmpeg
//
// Chunked by construction (§6): frames stream from the engine into an encoder with backpressure
// and are released at once; nothing holds the timeline. Never overwrites a file (rule 5).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MoshpitError } from '../errors';
import { samePath } from '@moshpit/core';
import type { ConformedSource, ExportConfig, ProjectDoc, SourceId } from '../model';
import type { Stage1Plan } from '../timeline/stage1';
import { findFfmpeg } from '../conform/ffmpeg';
import { rationalString } from '../time/clock';
import { H264Encoder } from './encode';
import { planAudio } from './audio';
import { lanesFor, mirrorWav } from '../audio/mirror';
import { AudioClock, RationalClock } from '../time/clock';
import type { Engine } from './engine';

export interface ExportReport {
  file: string;
  frames: number;
  audioSamples: number;
  ms: number;
  fps: number;
}

export interface ExportOptions {
  ffmpeg?: string;
  tmpDir: string;
  onProgress?: (fraction: number, frame: number) => void;
  signal?: AbortSignal;
  /** H.264 bitrate for mp4-h264, bits per second. Default 40 Mbps. */
  bitrate?: number;
}

const EXT: Record<ExportConfig['format'], string> = { 'mp4-h264': '.mp4', 'prores-422hq': '.mov', 'prores-4444': '.mov', hap: '.mov', hapq: '.mov', 'hap-alpha': '.mov', 'png-seq': '' };

function videoCodecArgs(f: ExportConfig['format']): string[] {
  switch (f) {
    case 'prores-422hq': return ['-c:v', 'prores_aw', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'];
    case 'prores-4444': return ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le'];
    case 'hap': return ['-c:v', 'hap', '-format', 'hap', '-chunks', '4', '-compressor', 'snappy'];
    case 'hapq': return ['-c:v', 'hap', '-format', 'hap_q', '-chunks', '4', '-compressor', 'snappy'];
    case 'hap-alpha': return ['-c:v', 'hap', '-format', 'hap_alpha', '-chunks', '4', '-compressor', 'snappy'];
    default: return [];
  }
}

/** Read-only sources (Phase 0.4): an output never lands on a source or its conform, whatever it is named. */
export function assertNotSource(doc: ProjectDoc, out: string): void {
  const protectedPaths = [...doc.resources.sources.map((s) => s.path), ...doc.resources.conforms.map((c) => c.path)];
  if (protectedPaths.some((p) => p && samePath(p, out))) throw new MoshpitError('SOURCE_PROTECTED', { path: out });
}

const cancelled = () => new DOMException('Export cancelled', 'AbortError');

/** Only this export's child is stopped. Settlement means close (stdio handles released),
 * not the earlier error event, so callers may safely remove its partial files afterward. */
function startWriter(bin: string, args: string[], signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
  const p = spawn(bin, args, { windowsHide: true });
  const controller = new AbortController();
  let closed = false, stopping = false, fault: unknown, stderr = '';
  const stop = (error: unknown = cancelled()) => {
    if (closed || stopping) return;
    stopping = true; fault ??= error;
    controller.abort(fault);
    p.stdin.destroy();
    p.kill();
  };
  const abort = () => stop(cancelled());
  const done = new Promise<void>((resolve, reject) => {
    p.stdout.resume();
    p.stderr.on('data', d => { stderr = (stderr + d).slice(-8000); });
    p.on('error', error => stop(error));
    p.stdin.on('error', error => stop(error));
    p.once('close', code => {
      closed = true;
      signal?.removeEventListener('abort', abort);
      if (fault || code !== 0) {
        const error = fault ?? new MoshpitError('EXPORT_FAILED', { stderr }, new Error(`ffmpeg exited ${code}`));
        fault = error; controller.abort(error); reject(error);
      } else { controller.abort(new Error('FFmpeg writer closed')); resolve(); }
    });
  });
  // A writer can fail while frames are being decoded, before the caller awaits done.
  void done.catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let drain: (() => void) | undefined, pending: Promise<void> | undefined;
  const clearDrain = () => { if (drain) p.stdin.removeListener('drain', drain); drain = undefined; pending = undefined; };
  return {
    signal: controller.signal, done, error: () => fault,
    write(bytes: Uint8Array) {
      if (controller.signal.aborted) throw fault ?? controller.signal.reason;
      if (!p.stdin.write(bytes)) pending = new Promise<void>(resolve => { drain = resolve; p.stdin.once('drain', drain); });
    },
    async ready() {
      if (controller.signal.aborted) throw fault ?? controller.signal.reason;
      if (pending) try { await Promise.race([pending, done.then(() => { throw new Error('FFmpeg closed before accepting all frames'); })]); }
      finally { clearDrain(); }
    },
    end: () => p.stdin.end(),
    async dispose() { clearDrain(); if (!closed) stop(); await done.catch(() => {}); },
  };
}

async function runWriter(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  const writer = startWriter(bin, args, signal);
  try { writer.end(); await writer.done; } finally { await writer.dispose(); }
}

export async function exportRange(e: Engine, doc: ProjectDoc, plan: Stage1Plan, cfg: ExportConfig, outPath: string, o: ExportOptions): Promise<ExportReport> {
  const [a, b] = cfg.range ?? [0, plan.frames - 1];
  const out = cfg.format === 'png-seq' ? outPath : (path.extname(outPath) ? outPath : outPath + EXT[cfg.format]);
  assertNotSource(doc, out);
  if (fs.existsSync(out)) throw new MoshpitError('EXPORT_EXISTS', { path: out });
  e.setOutputSize(cfg.width, cfg.height);
  const W = cfg.width, H = cfg.height;
  const { ffmpeg } = findFfmpeg(o.ffmpeg);
  fs.mkdirSync(o.tmpDir, { recursive: true });
  const stem = path.join(o.tmpDir, `export-${process.pid}-${randomUUID()}`);
  const conforms = new Map<SourceId, ConformedSource>(doc.resources.conforms.map((c) => [c.sourceId, c]));
  const t0 = performance.now();
  const n = b - a + 1;
  let written = 0; // E13: the report counts frames that reached the writer, not the range asked for
  const progress = (i: number, t: number) => { if (o.onProgress && (i & 7) === 0) o.onProgress(i / n, t); };
  const check = () => { if (o.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError'); };

  check();
  // Claim the name before encoding (an exclusive create), so the cleanup below can only ever delete
  // a file this run made: it used to delete `out` on any error, including another render's file
  // that took the name in between.
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    if (cfg.format === 'png-seq') fs.mkdirSync(out);
    else fs.closeSync(fs.openSync(out, 'wx'));
  } catch (err) {
    throw (err as NodeJS.ErrnoException).code === 'EEXIST' ? new MoshpitError('EXPORT_EXISTS', { path: out }) : err;
  }
  let wav: string | null = null, audioSamples = 0;
  const es = `${stem}.h264`, mirrored = `${stem}.mirror.wav`;
  try {
    if (cfg.audio && cfg.format !== 'png-seq') {
      wav = `${stem}.wav`;
      const ap = planAudio(plan.audio, conforms, plan.fps, [a, b], wav);
      await runWriter(ffmpeg, ap.args, o.signal);
      check();
      audioSamples = ap.samples;
      // M5 audio mirror: the sends, automated from the timeline, over the assembled clip audio.
      if (cfg.audioMirror !== false) {
        const off = new AudioClock(new RationalClock(plan.fps), 48000).sample(a);
        const lanes = lanesFor(plan.blocks, doc.timeline.blocks, plan.fps, 48000).map((l) => ({ ...l, start: l.start - off, end: l.end - off })).filter((l) => l.end > 0 && l.start < audioSamples);
        if (lanes.length) {
          mirrorWav(wav, mirrored, lanes, doc.settings.bpm);
          fs.rmSync(wav, { force: true });
          fs.renameSync(mirrored, wav);
        }
      }
    }
    if (cfg.format === 'mp4-h264') {
      const enc = await H264Encoder.open(es, W, H, plan.fps, { bitrate: o.bitrate ?? 40e6 });
      try {
        check();
        let i = 0;
        await e.renderRange(a, b, { signal: o.signal, onFrame: (px, t) => { check(); enc.encode(px, W, H, i++); written = i; progress(i, t); }, gate: () => enc.ready(o.signal) });
        await enc.close(o.signal);
      } finally { enc.dispose(); }
      check();
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-r', rationalString(plan.fps), '-f', 'h264', '-i', es];
      if (wav) args.push('-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k');
      // The pinned encoder preserves sRGB channel codes but replaces their descriptor
      // with SMPTE170M. Repair only primaries/transfer in SPS and MP4 metadata.
      // Keep its measured YUV matrix/range: assigning a 709 matrix would alter decoding.
      args.push('-c:v', 'copy', '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=13',
        '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1', '-max_interleave_delta', '0', '-movflags', '+faststart', out);
      await runWriter(ffmpeg, args, o.signal);
    } else {
      const target = cfg.format === 'png-seq' ? path.join(out, 'frame-%06d.png') : out;
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', rationalString(plan.fps), '-i', 'pipe:0'];
      if (wav) args.push('-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'pcm_s16le');
      args.push(...videoCodecArgs(cfg.format), '-fflags', '+bitexact', '-map_metadata', '-1', target);
      const writer = startWriter(ffmpeg, args, o.signal);
      try {
        let i = 0;
        await e.renderRange(a, b, {
          signal: writer.signal,
          onFrame: (px, t) => { check(); writer.write(Buffer.from(px)); i++; written = i; progress(i, t); },
          gate: () => writer.ready(),
        });
        writer.end();
        await writer.done;
      } catch (error) {
        if (!o.signal?.aborted && writer.error()) throw writer.error();
        throw error;
      } finally { await writer.dispose(); }
    }
    check();
    if (written !== n) throw new MoshpitError('EXPORT_FAILED', { out, why: `wrote ${written} of ${n} frames` });
  } catch (err) {
    fs.rmSync(out, { force: true, recursive: true }); // ours: claimed above
    throw err instanceof MoshpitError || (err as Error)?.name === 'AbortError' ? err : new MoshpitError('EXPORT_FAILED', { out }, err);
  } finally {
    for (const file of [wav, mirrored, es]) if (file) fs.rmSync(file, { force: true });
  }
  const ms = performance.now() - t0;
  return { file: out, frames: written, audioSamples, ms, fps: written / (ms / 1000) };
}
