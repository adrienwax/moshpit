// The pinned Chromium software H.264 encoder. NOT byte-deterministic (measured 2026-10-09, Electron
// 43.4.1): the same frames encoded twice differ from frame 3 on, about 50 dB PSNR apart, in variable
// and constant rate modes alike; 'quantizer' mode is refused. The frames fed in are identical (PNG
// export repeats exactly), and the ffmpeg formats (ProRes, HAP) repeat byte for byte. Writes an Annex-B elementary stream to a file descriptor as chunks
// arrive, with backpressure, so a long export holds one queue of frames, never the timeline (§6).

import * as fs from 'node:fs';
import { MoshpitError } from '../errors';
import type { Rational } from '@moshpit/core';
import { RationalClock } from '../time/clock';
import { conformLevel } from '../conform/level';

export class H264Encoder {
  private enc!: VideoEncoder;
  private disposed = false;
  private waiters = new Set<() => void>();
  private err: unknown = null;
  private clock: RationalClock;
  bytes = 0;
  frames = 0;

  private constructor(private fd: number, readonly codec: string, cfg: VideoEncoderConfig, fps: Rational, private keyEvery: number) {
    this.clock = new RationalClock(fps);
    try {
      this.enc = new VideoEncoder({
        output: (ch) => {
          if (this.disposed) return;
          try { const b = new Uint8Array(ch.byteLength); ch.copyTo(b); fs.writeSync(this.fd, b); this.bytes += b.length; }
          catch (e) { this.err = e; this.wake(); }
        },
        error: (e) => { this.err = e; this.wake(); },
      });
      this.enc.configure(cfg);
    } catch (e) { this.dispose(); throw e; }
  }

  static async open(file: string, w: number, h: number, fps: Rational, { bitrate = 40e6, keyEverySec = 2 } = {}): Promise<H264Encoder> {
    // Preserve the previous 5.1 codec choice except when UHD60 needs 5.2 (or larger).
    const level = Math.max(51, Math.round(Number(conformLevel(w, h, fps)) * 10)).toString(16).padStart(2, '0');
    for (const codec of [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`]) {
      const cfg: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps.num / fps.den, hardwareAcceleration: 'prefer-software', avc: { format: 'annexb' }, latencyMode: 'quality', bitrateMode: 'variable' };
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) {
        const fd = fs.openSync(file, 'wx'); // never overwrite (rule 5)
        return new H264Encoder(fd, codec, cfg, fps, Math.max(1, Math.round((keyEverySec * fps.num) / fps.den)));
      }
    }
    throw new MoshpitError('ENCODER_UNAVAILABLE', { w, h });
  }

  /** GPU egress is display-sRGB in BT.709 primaries (backend.ts), not linear RGB.
   * Encode one RGBA8 frame. Index i is the export's own frame counter, so timestamps start at 0. */
  encode(px: Uint8Array, w: number, h: number, i: number): void {
    if (this.err) throw new MoshpitError('EXPORT_FAILED', { frame: i }, this.err);
    const vf = new VideoFrame(px, { format: 'RGBA', colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true }, codedWidth: w, codedHeight: h, timestamp: this.clock.us(i), duration: this.clock.durationUs(i) });
    try { this.enc.encode(vf, { keyFrame: i % this.keyEvery === 0 }); } finally { vf.close(); }
    this.frames++;
  }

  private wake(): void { for (const wake of [...this.waiters]) wake(); }

  /** Drop pending chunks without flushing when the owning export fails or is cancelled. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { if (this.enc && this.enc.state !== 'closed') this.enc.close(); }
    finally { fs.closeSync(this.fd); this.wake(); }
  }

  /** Backpressure waits also settle on codec error, disposal or cancellation. */
  async ready(signal?: AbortSignal): Promise<void> {
    const check = () => {
      if (signal?.aborted || this.disposed) throw new DOMException('Export cancelled', 'AbortError');
      if (this.err) throw new MoshpitError('EXPORT_FAILED', {}, this.err);
    };
    check();
    if (this.enc.encodeQueueSize <= 4) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { this.enc.removeEventListener('dequeue', update); signal?.removeEventListener('abort', update); this.waiters.delete(update); };
      const update = () => {
        try { check(); if (this.enc.encodeQueueSize > 4) return; cleanup(); resolve(); }
        catch (e) { cleanup(); reject(e); }
      };
      this.enc.addEventListener('dequeue', update);
      signal?.addEventListener('abort', update, { once: true });
      this.waiters.add(update);
      update();
    });
  }

  async close(signal?: AbortSignal): Promise<void> {
    let abort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => { this.dispose(); reject(new DOMException('Export cancelled', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true });
      });
      await Promise.race([this.enc.flush(), cancelled]);
      if (this.err) throw new MoshpitError('EXPORT_FAILED', {}, this.err);
    } finally { if (abort) signal?.removeEventListener('abort', abort); this.dispose(); }
  }
}
