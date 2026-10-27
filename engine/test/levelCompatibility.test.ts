import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { conformArgs, probe } from '../src/conform/conform';
import { findFfmpeg } from '../src/conform/ffmpeg';
import { demux, openSamples } from '../src/bitstream/mp4';
import { annexBParameterSets, parseAvcC, parseSps, sameParameterSets, spliceParameterSets, toAnnexB } from '../src/bitstream/h264';
import { compileStage1, sampleBytes, type ClipInput } from '../src/timeline/stage1';
import type { Block, BlockId, SourceId, ConformedSource } from '../src/model';
import { CACHE, FIX } from './helpers';

const fps = { num: 60, den: 1 }, dir = join(CACHE, 'level-compatibility');
const clips = new Map<SourceId, ClipInput>();
const snapshots = new Map<string, Uint8Array>();
const block = (id: string, kind: Block['kind'] = 'picture'): Block => ({ id: id as BlockId, sourceId: id as SourceId,
  kind, in: 0, out: 24, repeat: 1, seam: { kind: 'seam.mosh', defVersion: 1, keepInnerKeyframes: false },
  graph: { nodes: [], edges: [] }, audio: { mute: true }, refs: [] });

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  const p = await probe(FIX('src-a.mp4'));
  for (const [id, level, width, rate] of [['old', '4.1', 1920, 60], ['new', '4.2', 1920, 60],
    ['size', '4.2', 1280, 60], ['timing', '4.2', 1920, 30]] as const) {
    const file = join(dir, `${id}.mp4`);
    const args = conformArgs(FIX('src-a.mp4'), file, p, { fps: { num: rate, den: 1 }, width,
      height: width === 1920 ? 1080 : 720, proxyDivisor: 4, crf: 18, range: { startSec: 0, durSec: .8 } }, false);
    args[args.indexOf('-level:v') + 1] = level;
    const result = spawnSync(findFfmpeg().ffmpeg, args, { maxBuffer: 4 << 20 });
    expect(result.status, String(result.stderr)).toBe(0);
    const video = demux(file), reader = openSamples(video);
    // Stage 1 only reads these fields; retain actual demuxed SPS and encoded samples.
    const record = { moshable: true, fps, conformedHash: id } as unknown as ConformedSource;
    clips.set(id as SourceId, { record, video, reader }); snapshots.set(id, video.avcC.slice());
  }
}, 120000);
afterAll(() => { for (const c of clips.values()) c.reader.close(); });

const config = (id: string) => clips.get(id as SourceId)!.video.avcC;
describe('legacy/new conform level compatibility', () => {
  it('keeps the exact comparator strict and promotes only identical Main SPS/PPS except the level', () => {
    expect(parseSps(parseAvcC(config('old')).sps[0]).levelIdc).toBe(41);
    expect(parseSps(parseAvcC(config('new')).sps[0]).levelIdc).toBe(42);
    expect(sameParameterSets(config('old'), config('new'))).toBe(false);
    expect(spliceParameterSets(config('old'), config('new'))).toBe(config('new'));
    expect(spliceParameterSets(config('new'), config('old'))).toBe(config('new'));
  });
  for (const ids of [['old', 'new'], ['new', 'old']]) it(`compiles ${ids.join(' then ')} and independently decodes every splice sample`, () => {
    const plan = compileStage1({ blocks: [block(ids[0]), block(ids[1], 'motion')], clips, fps });
    expect(plan.avcC).toBe(config('new'));
    expect(plan.codecString).toBe('avc1.4d402a');
    expect(parseSps(parseAvcC(plan.avcC).sps[0]).levelIdc).toBe(42);
    const parts: Uint8Array[] = [annexBParameterSets(plan.avcC)];
    for (let k = 0; k < plan.samples.length; k++) parts.push(toAnnexB(sampleBytes(plan, k)));
    const result = spawnSync(findFfmpeg().ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'h264', '-i', '-', '-f', 'framemd5', '-'],
      { input: Buffer.concat(parts), maxBuffer: 4 << 20 });
    expect(result.status, String(result.stderr)).toBe(0); expect(String(result.stderr).trim()).toBe('');
    const frames = String(result.stdout).split('\n').filter(line => line.trim() && !line.startsWith('#'));
    expect(frames).toHaveLength(plan.samples.length);
    for (const [id, before] of snapshots) expect(config(id)).toEqual(before);
  });
  it('still rejects actual dimension and VUI timing differences', () => {
    for (const id of ['size', 'timing']) {
      expect(spliceParameterSets(config('old'), config(id))).toBeNull();
      expect(() => compileStage1({ blocks: [block('old'), block(id)], clips, fps })).toThrow(/BITSTREAM_SPLICE_INCOMPATIBLE/);
    }
  });
  it('rejects every other changed avcC/SPS/PPS byte, including reference and constraint fields', () => {
    for (let i = 0; i < config('new').length; i++) {
      if (i === 3 || i === 11) continue;
      const changed = config('new').slice(); changed[i] ^= 1;
      expect(spliceParameterSets(config('old'), changed), `byte ${i}`).toBeNull();
    }
    const badLevel = config('new').slice(); badLevel[3] = badLevel[11] = 11;
    expect(spliceParameterSets(config('old'), badLevel)).toBeNull();
    const inconsistent = config('new').slice(); inconsistent[3] = 41;
    expect(spliceParameterSets(config('old'), inconsistent)).toBeNull();
  });
});
