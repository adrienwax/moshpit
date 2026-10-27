import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineService } from '../src/service/service';
import { newProject } from '../src/project/build';
import type { SourceClip, SourceId } from '../src/model';

const state = vi.hoisted(() => ({ rows: [] as { path: string; name: string; rating: number; tags: string[]; pass: true }[] }));
vi.mock('../src/library/index', async original => ({ ...await original<typeof import('../src/library/index')>(),
  LibraryIndex: class { async scan() {} async clips() { return state.rows; } close() {} },
}));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moshpit-library-range-'));
const file = path.join(dir, 'full-source.mp4'), services: EngineService[] = [];
afterEach(() => { for (const svc of services.splice(0)) svc.dispose(); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const source = (id: string, range?: SourceClip['range']) => ({ id: id as SourceId, path: file, ...(range ? { range } : {}) }) as SourceClip;
function setup(sources: SourceClip[]) {
  state.rows = [{ path: file, name: 'full-source.mp4', rating: 3, tags: ['test'], pass: true }];
  const svc = new EngineService({ cacheDir: dir, libraryRoots: [dir] }); services.push(svc);
  const doc = newProject('range association'); doc.resources.sources = sources; svc.updateProject(doc);
  return { svc, doc };
}
describe('whole-file library association after sliced imports', () => {
  it('does not advertise a partial import as the whole source', async () => {
    const { svc } = setup([source('slice', { startSec: 7, durSec: 2 })]);
    const [row] = await svc.libraryClips(dir);
    expect(row.sourceId).toBeUndefined(); expect(row.path).toBe(file); expect(row.rating).toBe(3);
  });
  it('finds a full-file source after an earlier partial import of the same path', async () => {
    const { svc } = setup([source('slice', { startSec: 7, durSec: 2 }), source('whole')]);
    expect((await svc.libraryClips(dir))[0].sourceId).toBe('whole');
  });
  it('preserves an existing whole-file association regardless of later zero-start slices', async () => {
    const { svc } = setup([source('whole'), source('first-second', { startSec: 0, durSec: 1 })]);
    expect((await svc.libraryClips(dir))[0].sourceId).toBe('whole');
  });
  it('recomputes association after a whole-file import is removed or a project is replaced', async () => {
    const { svc, doc } = setup([source('whole')]);
    expect((await svc.libraryClips(dir))[0].sourceId).toBe('whole');
    svc.updateProject({ ...doc, resources: { ...doc.resources, sources: [source('slice', { startSec: 0, durSec: 1 })] } });
    expect((await svc.libraryClips(dir))[0].sourceId).toBeUndefined();
    svc.updateProject(newProject('empty replacement'));
    expect((await svc.libraryClips(dir))[0].sourceId).toBeUndefined();
  });
});
