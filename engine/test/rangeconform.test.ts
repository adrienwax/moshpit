// P0 (Waxy, 2026-10-07): Use with IN/OUT imported the whole film. A source can now be a slice of
// its file: only that slice is conformed (proxy and master, keyframe-locked), it is keyed apart from
// the whole file, and an export waits for its master outside the worker queue, with progress.
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { conform, conformArgs, conformProxy, CONFORM_GOP } from '../src/conform/conform';
import { execFileSync } from 'node:child_process';
import { findFfmpeg } from '../src/conform/ffmpeg';
import { EngineService, validRange } from '../src/service/service';
import { newBlock, newProject } from '../src/project/build';
import type { ConformUpdate } from '../src/client';
import type { ProjectDoc, SourceId, SourceProbe } from '../src/model';
import { FIX, SETTINGS } from './helpers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3range-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const project = (): ProjectDoc => newProject('rg', { working: { w: 640, h: 360 } });

describe('slice conform (Use with IN/OUT)', () => {
  it('puts the cut in the ffmpeg args (and so in the cache key)', () => {
    const p = { codec: 'h264', width: 640, height: 360, fps: { num: 30, den: 1 }, durationSec: 10, pixFmt: 'yuv420p', hasAlpha: false } as SourceProbe;
    const whole = conformArgs('IN', 'OUT', p, SETTINGS, false);
    const cut = conformArgs('IN', 'OUT', p, { ...SETTINGS, range: { startSec: 2, durSec: 1.5 } }, false);
    expect(whole).not.toContain('-ss');
    expect(cut.slice(cut.indexOf('-ss'), cut.indexOf('-i'))).toEqual(['-ss', '2.000000', '-t', '1.500000']);
  });

  it('imports only the slice: frames = its length, master keyframe-locked to the proxy, apart from the whole file', async () => {
    const svc = new EngineService({ cacheDir: path.join(dir, 'svc') });
    const doc = project();
    svc.updateProject(doc);
    const fps = doc.settings.fps.num / doc.settings.fps.den;
    const seen: ConformUpdate[] = [];
    const off = svc.onConformUpdate((u) => seen.push(u));
    const r = await svc.importClip(FIX('src-a.mp4'), undefined, undefined, { range: { startSec: 2, durSec: 2 } });
    expect(r.source.range).toEqual({ startSec: 2, durSec: 2 });
    expect(r.conform.range).toEqual({ startSec: 2, durSec: 2 });
    expect(r.conform.frames).toBe(Math.round(2 * fps));

    // An export waits for the slice's master, reporting progress while it does.
    doc.resources.sources.push(r.source); doc.resources.conforms.push(r.conform);
    doc.timeline.blocks = [newBlock('picture', r.source.id, 0, 30)];
    svc.updateProject(doc);
    const progress: { conform?: { fraction: number; clips: number } }[] = [];
    await svc.awaitTimelineMasters((p) => progress.push(p));
    const ready = seen.find((u) => u.sourceId === r.source.id && u.state === 'READY')!;
    expect(ready.conform!.frames).toBe(r.conform.frames);
    expect(ready.conform!.keyframes).toEqual(r.conform.keyframes);
    expect(ready.conform!.range).toEqual({ startSec: 2, durSec: 2 });
    expect(progress[0].conform).toEqual({ fraction: 0, clips: 1 });
    expect(progress.at(-1)!.conform).toEqual({ fraction: 1, clips: 0 });

    // The whole file is a different conform, not a reuse of the slice.
    const whole = await svc.importClip(FIX('src-a.mp4'));
    expect(whole.conform.frames).toBeGreaterThan(r.conform.frames * 2);
    expect(whole.conform.path).not.toBe(r.conform.path);
    off(); svc.dispose();
  }, 120_000);

  // The source-range contract's edge cases (external review §2). OUT is exclusive everywhere: a
  // slice of n frames is [in, in + n), so these counts are exact, not ±1.
  const at = (startSec: number, durSec: number) => ({ ...SETTINGS, range: { startSec, durSec } });
  it('a single-frame slice is exactly one frame', async () => {
    const r = await conformProxy('one' as SourceId, FIX('src-a.mp4'), at(1, 1 / 30), path.join(dir, 'edge'));
    expect(r.frames).toBe(1);
  }, 60_000);

  it('a slice ending on the last frame of the file keeps it (src-a is 300 frames)', async () => {
    const last = await conformProxy('last' as SourceId, FIX('src-a.mp4'), at(299 / 30, 1 / 30), path.join(dir, 'edge'));
    expect(last.frames).toBe(1);
    const tail = await conformProxy('tail' as SourceId, FIX('src-a.mp4'), at(9, 1), path.join(dir, 'edge'));
    expect(tail.frames).toBe(30);
  }, 60_000);

  it('a slice crossing a GOP boundary: exact length, master keyframe-locked to the proxy', async () => {
    const r = await conform('gop' as SourceId, FIX('src-a.mp4'), at(3.9, 4.5), path.join(dir, 'gop'));
    expect(r.record.frames).toBe(135);
    expect(r.record.keyframes).toEqual([0, CONFORM_GOP]);
    expect(r.record.proxy!.conformedHash).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it('a variable-frame-rate file: the slice is its duration at the project rate', async () => {
    // 2 s at 30 fps then 2 s at 15 fps, timestamps kept as they are (VFR).
    const vfr = path.join(dir, 'vfr.mp4');
    execFileSync(findFfmpeg().ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=2',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vfr]);
    const r = await conformProxy('vfr' as SourceId, vfr, at(1, 2), path.join(dir, 'vfr'));
    expect(r.frames).toBe(60);
  }, 60_000);

  // P0-A (independent audit): a one-frame selection is under 0.04 s at 25, 30 and 60 fps; it used to
  // come back as "no range" and conform the whole file. Never null: at least one project frame.
  it('validRange keeps a one-frame selection at 25 / 29.97 / 30 / 60 fps, clamps, and refuses the impossible', () => {
    for (const fps of [{ num: 25, den: 1 }, { num: 30000, den: 1001 }, { num: 30, den: 1 }, { num: 60, den: 1 }]) {
      const frame = fps.den / fps.num;
      const r = validRange({ startSec: 2, durSec: frame }, 10, fps);
      expect(r).toEqual({ startSec: 2, durSec: frame });
      expect(validRange({ startSec: 2, durSec: frame / 3 }, 10, fps).durSec).toBeCloseTo(frame, 9); // sub-frame → one frame
    }
    expect(validRange({ startSec: 9.99, durSec: 0.001 }, 10, { num: 30, den: 1 })).toEqual({ startSec: 10 - 1 / 30, durSec: 1 / 30 }); // last frame kept
    const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { code?: string }).code; } };
    expect(code(() => validRange({ startSec: 11, durSec: 1 }, 10, { num: 30, den: 1 }))).toBe('SLICE_RANGE_INVALID');
    expect(code(() => validRange({ startSec: 1, durSec: 0 }, 10, { num: 30, den: 1 }))).toBe('SLICE_RANGE_INVALID');
  });

  it('importClip with a one-frame range at 60 fps conforms ONE frame, never the whole file', async () => {
    const svc = new EngineService({ cacheDir: path.join(dir, 'svc60') });
    const doc = newProject('rg60', { working: { w: 640, h: 360 }, fps: { num: 60, den: 1 } });
    svc.updateProject(doc);
    // A real 60 fps source (a 30 fps one would hold each frame for two project frames).
    const f60 = path.join(dir, 'src-60.mp4');
    execFileSync(findFfmpeg().ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=60:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f60]);
    const r = await svc.importClip(f60, undefined, undefined, { range: { startSec: 3, durSec: 1 / 60 } });
    expect(r.source.range).toBeDefined();
    expect(r.conform.frames).toBe(1);
    svc.dispose();
  }, 60_000);

  it('render() reports its master wait as conform progress (P1-A: it used to wait with logs only)', async () => {
    const svc = new EngineService({ cacheDir: path.join(dir, 'p1a') });
    svc.updateProject(project());
    const stop = new Error('stop before the export engine');
    let passed: unknown;
    (svc as unknown as { awaitTimelineMasters: (cb: unknown) => Promise<void> }).awaitTimelineMasters = async (cb) => { passed = cb; throw stop; };
    const onProgress = () => {};
    await expect(svc.render({ id: 'j', name: 'j', config: {} as never, outPath: path.join(dir, 'p1a.mp4') }, onProgress)).rejects.toBe(stop);
    expect(passed).toBe(onProgress);
    svc.dispose();
  });
});
