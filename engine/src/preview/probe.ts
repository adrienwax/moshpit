// Raw-file preview, step one: what is this file and can it be previewed natively? The source
// browser asks this before it scrubs anything. "Native" means WebCodecs decodes it and a
// PreviewSource can scrub it live; "filmstrip" means ffmpeg stills instead (preview/filmstrip.ts).
//
// The preview half of "one decoder, two modes" (BUILD-LOG, 7 Oct): approximate, disposable, any
// container Mediabunny reads. It never feeds the Engine: edit and export stay on conformed media.

import * as fs from 'node:fs';
import { extname } from 'node:path';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { MoshpitError } from '../errors';
import { probe as ffprobe } from '../conform/conform';

export type PreviewMode = 'native' | 'filmstrip';

/** Why a file falls back to the filmstrip. */
export type FilmstripReason =
  | 'container'  // Mediabunny cannot read it (AVI, MPEG-PS, …)
  | 'codec'      // a codec WebCodecs has no decoder for (ProRes, MPEG-2, MPEG-4 Part 2, MJPEG, …)
  | 'decoder';   // a WebCodecs codec this machine cannot decode (HEVC without a GPU decoder, HEVC 4:2:2, …)

export interface PreviewInfo {
  path: string;
  mode: PreviewMode;
  reason?: FilmstripReason;
  /** Mediabunny's container name, or ffprobe's for files it cannot read. */
  container: string;
  /** 'avc' | 'hevc' | 'vp9' | 'av1' | 'vp8' | 'prores', or ffprobe's codec name. */
  codec: string;
  /** Display size: after rotation and pixel aspect, what the viewer should show. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  durationSec: number;
  hdr: boolean;
  hasAudio: boolean;
}

/** How decodability is decided. In the worker this is WebCodecs; tests pass their own. */
export type Decodable = (config: VideoDecoderConfig) => Promise<boolean>;

const webcodecs: Decodable = async (config) => {
  if (typeof VideoDecoder === 'undefined') return false;
  try { return !!(await VideoDecoder.isConfigSupported(config)).supported; } catch { return false; }
};

export async function openInput(path: string): Promise<Input> {
  if (!fs.existsSync(path)) throw new MoshpitError('MEDIA_FILE_MISSING', { path });
  return new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
}

export async function previewInfo(path: string, decodable: Decodable = webcodecs, ffmpeg?: string): Promise<PreviewInfo> {
  const input = await openInput(path);
  try {
    let track = null, container = '';
    try {
      container = (await input.getFormat()).name;
      track = await input.getPrimaryVideoTrack();
    } catch { /* not a container Mediabunny reads: fall through to ffprobe */ }
    if (!track) return fromFfprobe(path, 'container', ffmpeg);
    const codec = await track.getCodec();
    const config = codec ? await track.getDecoderConfig() : null;
    const base = {
      path, container, codec: codec ?? 'unknown',
      width: await track.getDisplayWidth(), height: await track.getDisplayHeight(),
      rotation: await track.getRotation(), durationSec: await input.computeDuration(),
      hdr: await track.hasHighDynamicRange(), hasAudio: !!(await input.getPrimaryAudioTrack()),
    };
    if (!config || codec === 'prores') {
      // Mediabunny names the codec but WebCodecs has no decoder for it, or the codec is unknown to both.
      const ff = codec ? null : await ffprobe(path, ffmpeg).catch(() => null);
      return { ...base, codec: codec ?? ff?.codec ?? 'unknown', mode: 'filmstrip', reason: 'codec' };
    }
    return (await decodable(config)) ? { ...base, mode: 'native' } : { ...base, mode: 'filmstrip', reason: 'decoder' };
  } finally {
    input.dispose();
  }
}

/** Files Mediabunny cannot open: ffprobe still knows the size and length, which a filmstrip needs. */
async function fromFfprobe(path: string, reason: FilmstripReason, ffmpeg?: string): Promise<PreviewInfo> {
  const p = await ffprobe(path, ffmpeg);
  const rotation = (((p.rotation ?? 0) % 360) + 360) % 360 as PreviewInfo['rotation'];
  const turned = rotation === 90 || rotation === 270;
  return {
    path, mode: 'filmstrip', reason, container: extname(path).slice(1).toLowerCase() || 'unknown', codec: p.codec,
    width: turned ? p.height : p.width, height: turned ? p.width : p.height, rotation,
    durationSec: p.durationSec, hdr: !!p.transfer && ['smpte2084', 'arib-std-b67'].includes(p.transfer), hasAudio: !!p.audio,
  };
}
