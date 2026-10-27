import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { conform, conformArgs, probe, CONFORM_GOP } from '../src/conform/conform';
import { CONFORM_QUALITIES } from '@moshpit/core';
import { checkMoshable, parseAvcC, parseSps, sameParameterSets } from '../src/bitstream/h264';
import { demux } from '../src/bitstream/mp4';
import type { SourceId } from '../src/model';
import { MoshpitError } from '../src/errors';
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from '../src/conform/ffmpeg';
import { CACHE, FIX, SETTINGS, conformed } from './helpers';

describe('conform (L29)', () => {
  it('turns High-profile B-frame sources into the moshable form', async () => {
    for (const name of ['src-a.mp4', 'src-b.mp4', 'src-c.mp4']) {
      const { record, video } = await conformed(name);
      const sps = parseSps(parseAvcC(video.avcC).sps[0]);
      expect(sps.profileIdc, name).toBe(77); // Main
      expect(sps.pocType, name).toBe(2);
      expect(sps.maxRefFrames, name).toBe(1);
      expect(record.moshable).toBe(true);
      expect(record.fps).toEqual({ num: 30, den: 1 });
      expect([record.width, record.height]).toEqual([640, 360]);
      expect(record.keyframes.every((k) => k % CONFORM_GOP === 0)).toBe(true);
      expect(record.keyframes.length).toBe(Math.ceil(record.frames / CONFORM_GOP));
    }
  });

  it('retimes 25 fps to the project rate by frame count', async () => {
    const { record } = await conformed('src-b.mp4');
    expect(record.frames).toBe(240); // 8 s at 30/1
  });

  it('keeps the clip audio, resampled to 48 kHz (L27)', async () => {
    const a = (await conformed('src-a.mp4')).record, b = (await conformed('src-b.mp4')).record, c = (await conformed('src-c.mp4')).record;
    expect(a.audio).toMatchObject({ sampleRate: 48000, channels: 2 });
    expect(b.audio).toMatchObject({ sampleRate: 48000, channels: 1 });
    expect(c.audio).toBeUndefined();
  });

  it('gives every clip byte-identical parameter sets, so blocks can be spliced', async () => {
    const [a, b, c] = await Promise.all(['src-a.mp4', 'src-b.mp4', 'src-c.mp4'].map(conformed));
    expect(sameParameterSets(a.video.avcC, b.video.avcC)).toBe(true);
    expect(sameParameterSets(a.video.avcC, c.video.avcC)).toBe(true);
  });

  it('normalises colour tags, so a BT.709-tagged and a differently tagged clip still splice (E12)', async () => {
    // The fixtures are untagged; the bug needed a tagged source (the GoPro). Retag copies in the SPS.
    const dir = path.join(CACHE, 'e12');
    fs.mkdirSync(dir, { recursive: true });
    const tagged = (name: string, bsf: string) => {
      const out = path.join(dir, `${name}.mp4`);
      const r = spawnSync(findFfmpeg().ffmpeg, ['-v', 'error', '-y', '-i', FIX('src-c.mp4'), '-c', 'copy', '-bsf:v', `h264_metadata=${bsf}`, out]);
      expect(r.status, String(r.stderr)).toBe(0);
      return out;
    };
    const bt709 = tagged('bt709', 'colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1');
    const bt601 = tagged('bt601-full', 'colour_primaries=6:transfer_characteristics=6:matrix_coefficients=6:video_full_range_flag=1');
    expect((await probe(bt709)).transfer).toBe('bt709');
    const [a, b] = await Promise.all([conform('e12-a' as SourceId, bt709, SETTINGS, dir), conform('e12-b' as SourceId, bt601, SETTINGS, dir)]);
    const plain = (await conformed('src-a.mp4')).video;
    expect(sameParameterSets(a.video.avcC, b.video.avcC)).toBe(true);
    expect(sameParameterSets(a.video.avcC, plain.avcC)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the parameter sets of earlier conforms, so clips conformed before a preset change still splice', async () => {
    // Pinned from a v2 (preset medium) conform at 640×360. A conform change that moves these bytes
    // strands every clip already conformed: it must be deliberate, and this test must change with it.
    const { avcC } = (await conformed('src-a.mp4')).video;
    const ps = parseAvcC(avcC);
    expect(Buffer.from(ps.sps[0]).toString('hex')).toBe('674d4029da0280bfe5c05a808080a0000003002000000781e30654');
    expect(Buffer.from(ps.pps[0]).toString('hex')).toBe('68ef32c8');
  });

  it('conforms at every quality preset into one spliceable, moshable form, each under its own cache key', async () => {
    const dir = path.join(CACHE, 'quality');
    const ref = parseAvcC((await conformed('src-a.mp4')).video.avcC);
    const paths = new Set<string>();
    for (const q of CONFORM_QUALITIES) {
      const { record, video } = await conform(`q-${q.id}` as SourceId, FIX('src-c.mp4'), { ...SETTINGS, quality: q.id }, dir);
      const ps = parseAvcC(video.avcC);
      expect(record.quality).toBe(q.id);
      expect(record.args.join(' ')).toContain(`-preset ${q.x264}`);
      expect(record.moshable, q.id).toBe(true);
      expect(Buffer.from(ps.sps[0]).equals(Buffer.from(ref.sps[0])), `${q.id} SPS`).toBe(true);
      expect(Buffer.from(ps.pps[0]).equals(Buffer.from(ref.pps[0])), `${q.id} PPS`).toBe(true);
      paths.add(record.path);
    }
    expect(paths.size).toBe(CONFORM_QUALITIES.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reuses a finished conform with the same key and re-encodes when anything in the key changes', async () => {
    const dir = path.join(CACHE, 'reuse');
    fs.rmSync(dir, { recursive: true, force: true });
    const first = await conform('r1' as SourceId, FIX('src-c.mp4'), SETTINGS, dir);
    const t = performance.now();
    const again = await conform('r2' as SourceId, FIX('src-c.mp4'), SETTINGS, dir);
    const reuseMs = performance.now() - t;
    expect(again.record.notes).toContain('REUSED');
    expect(again.record.sourceId).toBe('r2');
    expect(again.record.path).toBe(first.record.path);
    expect(again.record.conformedHash).toBe(first.record.conformedHash);
    expect(reuseMs).toBeLessThan(2000);
    // D7's re-check must re-encode: same bytes, not a cache hit.
    const fresh = await conform('r3' as SourceId, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'fresh'), undefined, { reuse: false });
    expect(fresh.record.notes).not.toContain('REUSED');
    expect(fresh.record.conformedHash).toBe(first.record.conformedHash);
    // CRF was missing from the old cache name: a different CRF must be a different conform.
    const crf = await conform('r4' as SourceId, FIX('src-c.mp4'), { ...SETTINGS, crf: SETTINGS.crf + 2 }, dir);
    expect(crf.record.notes).not.toContain('REUSED');
    expect(crf.record.path).not.toBe(first.record.path);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('makes a keyframe-locked low-res proxy (decision 2)', async () => {
    const { record } = await conformed('src-a.mp4');
    const p = demux(record.proxy!.path);
    expect([p.width, p.height]).toEqual([160, 90]);
    expect(p.samples.length).toBe(record.frames);
    expect(p.keyframes).toEqual(record.keyframes);
    checkMoshable(p.avcC);
  });

  it('reproduces the same conformed hash when run again (D7)', async () => {
    const { record } = await conformed('src-c.mp4');
    const again = await conform('again' as SourceId, FIX('src-c.mp4'), SETTINGS, path.join(CACHE, 'again'));
    expect(again.record.conformedHash).toBe(record.conformedHash);
    fs.rmSync(path.join(CACHE, 'again'), { recursive: true, force: true });
  });

  it('records the exact arguments it ran, with the required flags', async () => {
    const { record } = await conformed('src-a.mp4');
    const a = record.args.join(' ');
    for (const flag of ['-profile:v main', '-bf 0', '-refs 1', '-flags:v +cgop', '-sc_threshold 0', 'stitchable=1']) expect(a).toContain(flag);
  });

  it('adds a tonemap for HDR transfers', async () => {
    const p = { ...(await probe(FIX('src-a.mp4'))), transfer: 'arib-std-b67' };
    expect(conformArgs('in', 'out', p, SETTINGS, false).join(' ')).toContain('tonemap=hable');
  });

  it('raises a structured error for a missing file', async () => {
    await expect(probe(FIX('nope.mp4'))).rejects.toMatchObject({ code: 'MEDIA_FILE_MISSING' });
    await expect(probe(FIX('nope.mp4'))).rejects.toBeInstanceOf(MoshpitError);
  });

  it('refuses a High-profile stream at the mosh contract', () => {
    const raw = demux(FIX('src-a.mp4'));
    expect(raw.sps).toBeNull();
    expect(() => checkMoshable(raw.avcC)).toThrowError(/BITSTREAM_PROFILE_UNSUPPORTED/);
  });
});
