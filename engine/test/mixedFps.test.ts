import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { conform, conformArgs } from '../src/conform/conform';
import { conformLevel } from '../src/conform/level';
import { findFfmpeg } from '../src/conform/ffmpeg';
import { sameParameterSets, parseAvcC, parseSps } from '../src/bitstream/h264';
import { demux } from '../src/bitstream/mp4';
import type { SourceId, SourceProbe } from '../src/model';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moshpit-mixed-fps-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('mixed-rate sources on a 1080p60 composition', () => {
  it('preserves duration, full working size and spliceable headers across 24/30/60 fps', async () => {
    const { ffmpeg } = findFfmpeg();
    let reference: Uint8Array | undefined;
    for (const fps of [24, 30, 60]) {
      const input = path.join(dir, `source-${fps}.mp4`);
      execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${fps}:duration=0.5`, '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', input]);
      const { record, video } = await conform(`fps-${fps}` as SourceId, input,
        { fps: { num: 60, den: 1 }, width: 1920, height: 1080, proxyDivisor: 4, crf: 15 }, dir);
      expect([record.width, record.height, record.frames]).toEqual([1920, 1080, 30]);
      expect(record.frames * record.fps.den / record.fps.num).toBe(0.5);
      expect(record.moshable).toBe(true);
      expect(parseSps(parseAvcC(video.avcC).sps[0]).levelIdc).toBe(42);
      if (reference) expect(sameParameterSets(reference, video.avcC)).toBe(true);
      reference = video.avcC;
      const proxy = demux(record.proxy!.path);
      expect(proxy.samples.length).toBe(30);
      expect([record.proxy!.width, record.proxy!.height]).toEqual([480, 270]);
    }
  }, 120_000);

  it('declares capacity for high frame rates without altering ordinary legacy headers', () => {
    expect(conformLevel(1920, 1080, { num: 30, den: 1 })).toBe('4.1');
    expect(conformLevel(1920, 1080, { num: 60000, den: 1001 })).toBe('4.2');
    expect(conformLevel(3840, 2160, { num: 30, den: 1 })).toBe('5.1');
    expect(conformLevel(3840, 2160, { num: 60, den: 1 })).toBe('5.2');
    const args = conformArgs('in', 'out', {} as SourceProbe, { fps: { num: 60, den: 1 }, width: 3840, height: 2160, proxyDivisor: 4, crf: 15 }, false);
    expect(args[args.indexOf('-level:v') + 1]).toBe('5.2');
  });
});
