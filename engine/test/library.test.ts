import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LibraryIndex } from '../src/library/index';
import { FIX } from './helpers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3lib-'));

describe('clip library index (EDENA scan.js, node:sqlite)', () => {
  const root = path.join(dir, 'media');
  fs.mkdirSync(path.join(root, 'underwater', 'turtles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'glitch'), { recursive: true });
  fs.copyFileSync(FIX('src-a.mp4'), path.join(root, 'underwater', 'a.mp4'));
  fs.copyFileSync(FIX('src-c.mp4'), path.join(root, 'underwater', 'turtles', 'c.mp4'));
  fs.copyFileSync(FIX('src-b.mp4'), path.join(root, 'glitch', 'b.MP4'));
  fs.writeFileSync(path.join(root, 'glitch', 'notes.txt'), 'not video');
  fs.writeFileSync(path.join(root, 'glitch', 'broken.mp4'), 'not really video');
  const lib = new LibraryIndex(path.join(dir, 'library.db'));
  afterAll(() => { lib.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('scans video files only into a folder tree with counts', async () => {
    const r = await lib.scan(root);
    expect(r).toMatchObject({ files: 4, removed: 0 });
    const t = lib.folders(root);
    const names = (f: typeof t): string[] => [f.name + ':' + f.count, ...f.children.flatMap(names)];
    expect(names(t).sort()).toEqual(['glitch:2', 'media:0', 'turtles:1', 'underwater:1']);
  });

  it('probes a folder lazily, caches it, and flags unreadable files with a code', async () => {
    const clips = await lib.clips(path.join(root, 'glitch'));
    expect(clips.map((c) => [c.name, c.probe?.codec ?? null, c.pass])).toEqual([['b.MP4', 'h264', true], ['broken.mp4', null, { code: 'MEDIA_UNREADABLE' }]]);
    const t = performance.now();
    await lib.clips(path.join(root, 'glitch'));
    expect(performance.now() - t).toBeLessThan(50); // cached: no ffprobe the second time
  });

  it('keeps ratings and tags through a rescan and drops deleted files', async () => {
    const a = path.join(root, 'underwater', 'a.mp4');
    lib.setRating(a, 4); lib.setTags(a, ['ocean', ' blue ', 'ocean']);
    fs.rmSync(path.join(root, 'glitch', 'broken.mp4'));
    const r = await lib.scan(root);
    expect(r).toMatchObject({ files: 3, removed: 1 });
    const [clip] = await lib.clips(path.join(root, 'underwater'));
    expect([clip.rating, clip.tags]).toEqual([4, ['blue', 'ocean']]);
  });

  it('walks 5,000 files in a few seconds', async () => {
    const big = path.join(dir, 'big');
    for (let d = 0; d < 50; d++) { fs.mkdirSync(path.join(big, `d${d}`), { recursive: true }); for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(big, `d${d}`, `clip${i}.mp4`), ''); }
    const t = performance.now();
    const r = await lib.scan(big);
    expect(r.files).toBe(5000);
    expect(performance.now() - t).toBeLessThan(15_000); // a generous ceiling: this runs beside other suites
    expect(lib.folders(big).children.length).toBe(50);
  });
});

describe('library roots at runtime (E14)', () => {
  it('setLibraryRoots switches roots and rescans without a restart', async () => {
    const { EngineService } = await import('../src/service/service');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3roots-'));
    const one = path.join(d, 'one'), two = path.join(d, 'two');
    fs.mkdirSync(one); fs.mkdirSync(two);
    fs.copyFileSync(FIX('src-a.mp4'), path.join(one, 'a.mp4'));
    fs.copyFileSync(FIX('src-b.mp4'), path.join(two, 'b.mp4'));
    const svc = new EngineService({ cacheDir: path.join(d, 'cache'), libraryRoots: [one] });
    try {
      expect((await svc.libraryFolders()).map((f) => [f.path, f.count])).toEqual([[one, 1]]);
      expect((await svc.setLibraryRoots([two])).map((f) => [f.path, f.count])).toEqual([[two, 1]]);
      fs.copyFileSync(FIX('src-c.mp4'), path.join(two, 'c.mp4'));
      expect((await svc.libraryFolders())[0].count).toBe(1); // cached until asked to rescan
      expect((await svc.setLibraryRoots([two]))[0].count).toBe(2); // same roots again = rescan
    } finally { svc.dispose?.(); fs.rmSync(d, { recursive: true, force: true }); }
  });
});
