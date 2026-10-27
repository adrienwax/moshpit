import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { previewInfo } from '../src/preview/probe';
import { filmstrip } from '../src/preview/filmstrip';
import { fit } from '../src/preview/source';
import { FIX } from './helpers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3preview-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// Node has no WebCodecs: stand in for a machine that decodes everything WebCodecs can be asked for.
const yes = async () => true;

describe('raw-file preview: what a file is and how it previews', () => {
  it.each([
    ['src-a.mp4', 'native', undefined, 'avc'],
    ['pv-h264.mkv', 'native', undefined, 'avc'],
    ['pv-vp9.webm', 'native', undefined, 'vp9'],
    ['pv-hevc.mp4', 'native', undefined, 'hevc'],
    ['pv-av1.mp4', 'native', undefined, 'av1'],
    ['pv-prores.mov', 'filmstrip', 'codec', 'prores'],
    ['pv-mpeg2.mpg', 'filmstrip', 'container', 'mpeg2video'],
    ['pv-mjpeg.avi', 'filmstrip', 'container', 'mjpeg'],
  ])('%s → %s', async (name, mode, reason, codec) => {
    const info = await previewInfo(FIX(name), yes);
    expect(info.mode).toBe(mode);
    expect(info.reason).toBe(reason);
    expect(info.codec).toBe(codec);
    expect(info.durationSec).toBeGreaterThan(2.5);
    expect(info.width).toBeGreaterThan(0);
  });

  it('a codec this machine cannot decode falls back with reason "decoder"', async () => {
    const info = await previewInfo(FIX('pv-hevc.mp4'), async () => false);
    expect(info).toMatchObject({ mode: 'filmstrip', reason: 'decoder', codec: 'hevc' });
  });

  it('reports the display size after rotation', async () => {
    const info = await previewInfo(FIX('pv-rot90.mp4'), yes);
    expect(info.rotation % 180).toBe(90);
    expect([info.width, info.height]).toEqual([180, 320]);
  });

  it('fits frames inside the box at the display aspect, never upscaling', () => {
    expect(fit({ w: 1920, h: 1080 }, { w: 320, h: 320 })).toEqual({ w: 320, h: 180 });
    expect(fit({ w: 180, h: 320 }, { w: 320, h: 160 })).toEqual({ w: 90, h: 160 });
    expect(fit({ w: 320, h: 180 }, { w: 1920, h: 1080 })).toEqual({ w: 320, h: 180 });
  });
});

describe('filmstrip fallback (ffmpeg stills)', () => {
  it.each(['pv-prores.mov', 'pv-mpeg2.mpg', 'pv-mjpeg.avi', 'pv-rot90.mp4'])('%s: evenly spaced JPEG stills, cached', async (name) => {
    const cache = path.join(dir, 'fs');
    const t0 = performance.now();
    const a = await filmstrip(FIX(name), cache, { count: 6, width: 96 });
    const cold = performance.now() - t0;
    expect(a.cells).toHaveLength(6);
    expect(a.cells.every((c) => c.jpeg[0] === 0xff && c.jpeg[1] === 0xd8)).toBe(true);
    expect(a.cells.map((c) => c.time)).toEqual([...a.cells.map((c) => c.time)].sort((x, y) => x - y));
    expect(a.cells.at(-1)!.time).toBeLessThan(a.durationSec);
    const t1 = performance.now();
    const b = await filmstrip(FIX(name), cache, { count: 6, width: 96 });
    expect(performance.now() - t1).toBeLessThan(Math.max(50, cold / 4));
    expect(Buffer.from(b.cells[3].jpeg).equals(Buffer.from(a.cells[3].jpeg))).toBe(true);
  });

  it('a rotated clip gives upright stills', async () => {
    const s = await filmstrip(FIX('pv-rot90.mp4'), path.join(dir, 'rot'), { count: 1, width: 90 });
    // JPEG SOF0 holds height then width; upright 180×320 scaled to width 90 is 90×160.
    const j = Buffer.from(s.cells[0].jpeg);
    const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
    expect([j.readUInt16BE(sof + 7), j.readUInt16BE(sof + 5)]).toEqual([90, 160]);
  });
});
