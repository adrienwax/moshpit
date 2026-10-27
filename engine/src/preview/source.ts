// Raw-file preview, step two: scrub one unconformed clip in the source browser. Runs where
// WebCodecs exists (the render worker), on Mediabunny's own decoders: a PreviewSource never
// touches an Engine, a stage-1 plan or a conform, so preview cannot disturb edit or export
// determinism ("one decoder, two modes", BUILD-LOG 7 Oct).
//
//   snap  (pointer moving): the keyframe at or before t, one packet decoded. 2–15 ms on real files.
//   exact (pointer resting): the frame shown at t, decoded from its keyframe. 15–134 ms on phone
//         and export footage, up to ~1 s on long-GOP downloads.
// Latest request wins: a request superseded while it waits resolves null without decoding.

import { EncodedPacketSink, VideoSampleSink, type Input, type InputVideoTrack, type VideoSample } from 'mediabunny';
import { MoshpitError } from '../errors';
import { openInput } from './probe';

export interface PreviewFrame {
  w: number;
  h: number;
  /** RGBA8, rotation applied, fitted inside the requested box at the display aspect. */
  data: Uint8Array;
  /** Seconds from the first frame: the frame actually shown (a snap lands on the keyframe). */
  time: number;
  exact: boolean;
}

export interface FrameRequest {
  /** False (default): snap to the keyframe at or before t. True: the exact frame at t. */
  exact?: boolean;
  /** Forward playback keeps one sequential decoder alive; paused scrubbing still uses exact seeks. */
  playback?: boolean;
  /** The box to fit inside; the frame keeps the clip's display aspect and never upscales. */
  size: { w: number; h: number };
}

const CACHE = 48;

export class PreviewSource {
  private cache = new Map<string, PreviewFrame>();
  private gen = 0;
  private busy: Promise<void> = Promise.resolve();
  private closed = false;
  private first?: Promise<number>;
  private stream?: AsyncGenerator<VideoSample>;
  private currentSample?: VideoSample;
  private nextSample?: VideoSample;
  private streamDone = false;
  private streamAt = -Infinity;

  // Two decoders: snaps only ever decode keyframes, so they never wait behind an exact seek's
  // run of frames on a long-GOP file (310 ms median on a Blu-ray MKV when they shared one).
  private constructor(readonly path: string, private input: Input, private track: InputVideoTrack, private snaps: VideoSampleSink, private exacts: VideoSampleSink, private packets: EncodedPacketSink, readonly display: { w: number; h: number }, readonly durationSec: number) {}

  static async open(path: string): Promise<PreviewSource> {
    const input = await openInput(path);
    try {
      const track = await input.getPrimaryVideoTrack().catch(() => null);
      if (!track) throw new MoshpitError('PREVIEW_UNSUPPORTED', { path, why: 'no video track Mediabunny can read; use the filmstrip' });
      const config = await track.getDecoderConfig();
      const ok = !!config && typeof VideoDecoder !== 'undefined' && !!(await VideoDecoder.isConfigSupported(config).catch(() => null))?.supported;
      if (!ok) throw new MoshpitError('PREVIEW_UNSUPPORTED', { path, codec: await track.getCodec(), why: 'no WebCodecs decoder for this codec here; use the filmstrip' });
      const display = { w: await track.getDisplayWidth(), h: await track.getDisplayHeight() };
      return new PreviewSource(path, input, track, new VideoSampleSink(track), new VideoSampleSink(track), new EncodedPacketSink(track), display, await input.computeDuration());
    } catch (e) { input.dispose(); throw e; }
  }

  /** A frame for the browser, or null when a newer request superseded this one. */
  async frame(t: number, req: FrameRequest): Promise<PreviewFrame | null> {
    if (this.closed) throw new MoshpitError('PREVIEW_UNSUPPORTED', { path: this.path, why: 'preview closed' });
    const my = ++this.gen;
    const prev = this.busy;
    let release!: () => void;
    this.busy = new Promise((r) => { release = r; });
    try {
      await prev;
      if (my !== this.gen || this.closed) return null;
      return await this.decode(Math.max(0, Math.min(this.durationSec, t)), req);
    } finally { release(); }
  }

  private async decode(t: number, req: FrameRequest): Promise<PreviewFrame | null> {
    const exact = !!req.exact || !!req.playback;
    const { w, h } = fit(this.display, req.size);
    // t counts from the first frame, as the browser's frame numbers and ffmpeg's -ss do: a file
    // whose first frame sits at 0.033 s (GoPro) showed frame n − 1 for n, and nothing for frame 0.
    const first = await (this.first ??= this.track.getFirstTimestamp());
    let at = first + t;
    if (!exact) {
      const key = await this.packets.getKeyPacket(at, { metadataOnly: true });
      if (this.closed) return null;
      at = key ? key.timestamp : first;
    }
    if (this.closed) return null;
    const ck = `${exact ? 'e' : 'k'}:${at.toFixed(4)}:${w}x${h}`;
    if (!req.playback) await this.clearPlayback();
    const hit = !req.playback && this.cache.get(ck);
    if (hit) { this.cache.delete(ck); this.cache.set(ck, hit); return hit; }
    const sample = req.playback ? await this.playbackSample(at) : await (exact ? this.exacts : this.snaps).getSample(at);
    if (!sample) return null; // before the first frame
    if (this.closed) { if (!req.playback) sample.close(); return null; }
    try {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      sample.draw(ctx, 0, 0, w, h); // rotation and flip from the file's metadata
      const out: PreviewFrame = { w, h, data: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer), time: sample.timestamp - first, exact };
      if (!req.playback) this.cache.set(ck, out);
      if (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
      return out;
    } finally { if (!req.playback) sample.close(); }
  }

  private async clearPlayback(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    this.currentSample?.close(); this.currentSample = undefined;
    this.nextSample?.close(); this.nextSample = undefined;
    this.streamDone = false; this.streamAt = -Infinity;
    await stream?.return(undefined);
  }

  private async playbackSample(at: number): Promise<VideoSample | null> {
    // Loop/backward seek or a large jump starts a fresh run. Normal cadence consumes packets
    // once, including variable-frame-rate/B-frame presentation order, rather than seeking GOPs.
    if (!this.stream || at < this.streamAt || at - this.streamAt > 1) {
      await this.clearPlayback();
      this.stream = this.exacts.samples(at);
      this.currentSample = (await this.stream.next()).value;
    }
    this.streamAt = at;
    if (!this.currentSample) return null;
    while (!this.streamDone) {
      if (!this.nextSample) {
        const next = await this.stream.next();
        this.streamDone = !!next.done;
        this.nextSample = next.value;
      }
      if (!this.nextSample || this.nextSample.timestamp > at) break;
      this.currentSample.close();
      this.currentSample = this.nextSample;
      this.nextSample = undefined;
    }
    return this.currentSample;
  }

  /**
   * Release the decoders. A request still decoding keeps the input until it settles (and then
   * resolves null): disposing under it threw InputDisposedError, which reached the UI as a fatal
   * INTERNAL from previewFrame (Waxy, 2026-10-08) — the browser closing a file, or the 4-file LRU
   * evicting one, while its frame was in flight.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.gen++;
    this.cache.clear();
    const dispose = async () => { try { await this.clearPlayback(); } finally { this.input.dispose(); } };
    void this.busy.then(dispose, dispose);
  }
}

/** Fit the display size inside the box, keeping its aspect, never upscaling. */
export function fit(display: { w: number; h: number }, box: { w: number; h: number }): { w: number; h: number } {
  const s = Math.min(1, box.w / display.w, box.h / display.h);
  return { w: Math.max(1, Math.round(display.w * s)), h: Math.max(1, Math.round(display.h * s)) };
}
