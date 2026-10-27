// Folder navigation (Waxy's report: stuck at the library roots). The service lists any folder's
// subfolders from disk (and the drives), and a folder opened outside the roots is indexed shallowly:
// its own clips, not its subfolders'.
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LibraryIndex, isUnder } from '../src/library/index';
import { EngineService } from '../src/service/service';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3nav-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const touch = (p: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, 'x'));

describe('folder navigation', () => {
  it('listDir: subfolders in order (hidden and system ones skipped), the parent, and the drives', async () => {
    const top = path.join(dir, 'footage');
    for (const d of ['b roll', 'A cam', '10 night', '2 day', '.cache', '$RECYCLE.BIN']) fs.mkdirSync(path.join(top, d), { recursive: true });
    touch(path.join(top, 'clip.mp4'));
    const svc = new EngineService({ cacheDir: path.join(dir, 'cache'), libraryRoots: [] });
    const l = await svc.listDir(top);
    expect(l.dirs.map((d) => d.name)).toEqual(['2 day', '10 night', 'A cam', 'b roll']);
    expect(l.parent).toBe(path.dirname(path.resolve(top)));
    const drives = await svc.listDir('');
    expect(drives.parent).toBeNull();
    expect(drives.dirs.some((d) => /^[A-Z]:$/.test(d.name))).toBe(true);
    await expect(svc.listDir(path.join(dir, 'nope'))).rejects.toThrow(/MEDIA_FILE_MISSING/);
  });

  it('a shallow scan indexes the folder’s own clips only', async () => {
    const top = path.join(dir, 'shallow');
    touch(path.join(top, 'a.mp4'));
    touch(path.join(top, 'b.mov'));
    touch(path.join(top, 'deeper', 'c.mp4'));
    const lib = new LibraryIndex(path.join(dir, 'lib.db'));
    const r = await lib.scan(top, undefined, undefined, true);
    expect(r.files).toBe(2);
    const deep = await lib.scan(path.join(dir, 'shallow'), undefined, undefined, false);
    expect(deep.files).toBe(3);
    lib.close();
  });

  it('isUnder: whole path segments, either slash, any case (bug hunt)', () => {
    expect(isUnder(String.raw`D:\Videos\a`, String.raw`D:\Videos`)).toBe(true);
    expect(isUnder('d:/videos', String.raw`D:\Videos\ `.trim())).toBe(true);
    expect(isUnder(String.raw`D:\Videos-old`, String.raw`D:\Videos`)).toBe(false);
    expect(isUnder(String.raw`X:\example-media\x`, String.raw`X:\example`)).toBe(false);
  });

  it('a folder first indexed shallowly joins its root when that root is walked (bug hunt)', async () => {
    const top = path.join(dir, 'later-root'), sub = path.join(top, 'clips');
    touch(path.join(sub, 'x.mp4'));
    const lib = new LibraryIndex(path.join(dir, 'lib2.db'));
    await lib.scan(sub, undefined, undefined, true);
    await lib.scan(top);
    const tree = lib.folders(top);
    expect(tree.children.map((c) => c.name)).toEqual(['clips']);
    lib.close();
  });
});
