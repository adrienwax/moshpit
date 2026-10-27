import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capFreezes, engineCacheDir, engineCacheRoot, mediaRootsOf, migrateEngineCache, previewDir, rebaseCachePaths, sweepPartialEncodes } from '../electron/engine-cache';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ec-'));
const put = (p: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, 'x'));

describe('engine cache out of Chromium Cache', () => {
  it('moves only the engine entries, leaves Chromium files, and is idempotent', () => {
    const ud = tmp();
    put(path.join(ud, 'cache', 'conform', 'a.mp4'));
    put(path.join(ud, 'cache', 'library.db'));
    put(path.join(ud, 'cache', 'Cache_Data', 'index'));
    expect(migrateEngineCache(ud).sort()).toEqual(['conform', 'library.db']);
    expect(fs.existsSync(path.join(engineCacheDir(ud), 'conform', 'a.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(ud, 'cache', 'Cache_Data', 'index'))).toBe(true);
    expect(migrateEngineCache(ud)).toEqual([]);
    fs.rmSync(ud, { recursive: true, force: true });
  });
  it('rebases a saved conform path only when the file moved', () => {
    const ud = tmp();
    put(path.join(engineCacheDir(ud), 'conform', 'a.mp4'));
    const old = path.join(ud, 'cache', 'conform', 'a.mp4');
    const elsewhere = path.join(ud, 'other', 'b.mp4');
    const doc = { resources: { conforms: [{ path: old, proxy: { path: old } }, { path: elsewhere }] } } as never;
    rebaseCachePaths(doc, ud);
    const c = (doc as { resources: { conforms: { path: string; proxy?: { path: string } }[] } }).resources.conforms;
    expect(c[0].path).toBe(path.join(engineCacheDir(ud), 'conform', 'a.mp4'));
    expect(c[0].proxy!.path).toBe(c[0].path);
    expect(c[1].path).toBe(elsewhere);
    fs.rmSync(ud, { recursive: true, force: true });
  });
  it('sweeps partial encodes whose process is gone, keeps a live one and finished files', () => {
    const d = tmp();
    put(path.join(d, 'a.tmp-111-abcd.mp4'));
    put(path.join(d, 'b.tmp-222-beef.mp4'));
    put(path.join(d, 'c.mp4'));
    const r = sweepPartialEncodes(d, (pid) => pid === 222);
    expect(r.files).toBe(1);
    expect(fs.readdirSync(d).sort()).toEqual(['b.tmp-222-beef.mp4', 'c.mp4']);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('engine cache root: env override, test profile, Settings cache (engine subfolder), profile fallback', () => {
    const ud = tmp(), set = tmp();
    expect(engineCacheRoot(ud, set, { MOSHPIT_ENGINE_CACHE: 'X:\c' })).toBe('X:\c');
    expect(engineCacheRoot(ud, set, { MOSHPIT_CACHE_IN_PROFILE: '1' })).toBe(engineCacheDir(ud));
    expect(engineCacheRoot(ud, undefined, {})).toBe(engineCacheDir(ud));
    expect(engineCacheRoot(ud, '', {})).toBe(engineCacheDir(ud));
    expect(engineCacheRoot(ud, set, {})).toBe(path.join(set, 'engine'));
    expect(fs.existsSync(path.join(set, 'engine'))).toBe(true);
    expect(engineCacheRoot(ud, 'Q:\nowhere', {})).toBe(engineCacheDir(ud)); // no such drive
    fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(set, { recursive: true, force: true });
  });

  // Phase 0.4: Moshpit's cache never mixes with footage, and the preview slot is fixed by main.
  it('a Settings cache that overlaps a media root falls back to the profile', () => {
    const ud = tmp(), media = tmp();
    const inside = path.join(media, 'cache');
    expect(engineCacheRoot(ud, inside, {}, [media])).toBe(engineCacheDir(ud));
    expect(engineCacheRoot(ud, media, {}, [path.join(media, 'raw')])).toBe(engineCacheDir(ud)); // holds a root
    expect(fs.existsSync(path.join(inside, 'engine'))).toBe(false); // nothing created in the footage
    fs.rmSync(ud, { recursive: true, force: true }); fs.rmSync(media, { recursive: true, force: true });
  });

  it('the preview folder: <Settings cache>\\preview, else the profile (never a drive root or a media root)', () => {
    const ud = 'C:\\ud', vids = 'C:\\Users\\x\\Videos';
    expect(previewDir(ud, 'X:\\ExampleMedia\\.cache', mediaRootsOf('Y:\\ExampleMedia\\raw', vids))).toBe(path.join('X:\\ExampleMedia\\.cache', 'preview'));
    expect(previewDir(ud, '', mediaRootsOf('', vids))).toBe(path.join(engineCacheDir(ud), 'preview')); // used to be \preview
    expect(previewDir(ud, 'relative\\dir', [])).toBe(path.join(engineCacheDir(ud), 'preview'));
    expect(previewDir(ud, 'Y:\\ExampleMedia', mediaRootsOf('Y:\\ExampleMedia\\raw', vids))).toBe(path.join(engineCacheDir(ud), 'preview'));
    expect(mediaRootsOf(' ; ', vids)).toEqual([vids]);
  });

  it('caps the freeze cache: oldest first, keeps what the project uses', () => {
    const d = tmp();
    const mk = (k: string, kb: number, age: number) => { const p = path.join(d, k + '.rgba'); fs.writeFileSync(p, Buffer.alloc(kb * 1024)); const t = Date.now() / 1000 - age; fs.utimesSync(p, t, t); };
    mk('old', 100, 300); mk('used', 100, 200); mk('mid', 100, 100); mk('new', 100, 0);
    const r = capFreezes(d, 250 * 1024, new Set(['used']));
    expect(r.files).toBe(2);
    expect(fs.readdirSync(d).sort()).toEqual(['new.rgba', 'used.rgba']);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
