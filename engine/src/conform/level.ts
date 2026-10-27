import type { Rational } from '@moshpit/core';

/** Keep legacy 4.1 parameter sets at ordinary rates, but declare enough decode capacity for
 * 1080p60 / UHD. H.264 Annex A frame-size and macroblock-rate limits, also published in FFmpeg's
 * libavcodec/h264_levels.c. The conform has one reference frame; bitrate remains CRF-controlled. */
export function conformLevel(width: number, height: number, fps: Rational): string {
  const x = Math.ceil(width / 16), y = Math.ceil(height / 16), blocks = x * y;
  const levels = [
    ['4.1', 8192, 245760], ['4.2', 8704, 522240], ['5.0', 22080, 589824],
    ['5.1', 36864, 983040], ['5.2', 36864, 2073600], ['6.0', 139264, 4177920],
  ] as const;
  const hit = levels.find(([, maxFrame, maxRate]) => blocks <= maxFrame && x * x <= 8 * maxFrame && y * y <= 8 * maxFrame && blocks * fps.num <= maxRate * fps.den);
  if (!hit) throw new Error(`Unsupported conform dimensions/rate: ${width}×${height} at ${fps.num}/${fps.den}`);
  return hit[0];
}
