import { describe, expect, it } from 'vitest';
import type { LibraryClip, LibraryFolder } from '../src/engine';
import { visibleClips, visibleFolders } from '../src/ws/browse/browseModel';
import { createBrowseCommands } from '../src/state/browseControl';
const clip = (name: string, duration: number, rating: number, tags: string[] = []): LibraryClip => ({
  path: name, name, rating, tags, pass: true,
  probe: { codec: 'HAP', durationSec: duration, width: 100, height: 100 },
} as LibraryClip);
const clips = [clip('z.mov', 10, 1), clip('b.mov', 30, 5, ['motion']), clip('a.mov', 20, 4, ['motion'])];
describe('the visible IN model is also the hardware stepping order', () => {
  it('filters by name, codec and tag, sorts, and does not mutate the library order', () => {
    expect(visibleClips(clips).map(c => c.path)).toEqual(['a.mov', 'b.mov', 'z.mov']);
    expect(visibleClips(clips, 'motion', ['stars'], 'duration').map(c => c.path)).toEqual(['b.mov', 'a.mov']);
    expect(visibleClips(clips, 'hap', [], 'rating').map(c => c.path)).toEqual(['b.mov', 'a.mov', 'z.mov']);
    expect(visibleClips(clips, 'missing')).toEqual([]);
    expect(clips.map(c => c.path)).toEqual(['z.mov', 'b.mov', 'a.mov']);
  });
  it('uses current search/sort/chips on consecutive commands and stops at visible ends', () => {
    let path = 'b.mov', query = 'motion';
    const command = createBrowseCommands({
      selection: () => ({ path, frames: 100, frame: 0, marks: null, usable: true }),
      paths: () => visibleClips(clips, query, ['stars'], 'duration').map(c => c.path),
      select: next => { path = next; }, marks() {}, send() {}, notice() {},
    });
    command('clip.next'); expect(path).toBe('a.mov');
    command('clip.next'); expect(path).toBe('a.mov');
    command('clip.prev'); expect(path).toBe('b.mov');
    query = 'missing'; command('clip.next'); expect(path).toBe('b.mov');
    query = 'a.mov'; command('clip.next'); expect(path).toBe('a.mov');
  });
  it('ignores obsolete filter IDs instead of breaking hardware navigation', () => {
    expect(visibleClips(clips, '', ['retired-filter']).length).toBe(3);
  });
  it('coarse clip detents advance five visible items in one selection, then clamp', () => {
    const list = Array.from({ length: 12 }, (_, i) => clip(`clip-${String(i).padStart(2, '0')}`, i, 5));
    let path = list[0].path, selections = 0;
    const command = createBrowseCommands({
      selection: () => ({ path, frames: 100, frame: 0, marks: null, usable: true }),
      paths: () => visibleClips(list).map(c => c.path),
      select: next => { selections++; path = next; }, marks() {}, send() {}, notice() {},
    });
    command('clip.next', { mode: 'coarse', repeat: 2 });
    expect(path).toBe(list[10].path); expect(selections).toBe(1);
    command('clip.next', { mode: 'coarse' }); expect(path).toBe(list[11].path);
    command('clip.prev', { mode: 'fine' }); expect(path).toBe(list[10].path);
  });
});

it('folder detents use only expanded library rows in stable visible tree order', () => {
  const folder = (path: string, children: LibraryFolder[] = []) => ({ path, name: path, children, count: 0 });
  const tree = [folder('A', [folder('A/1', [folder('A/1/hidden')]), folder('A/2')]), folder('B')];
  expect(visibleFolders(tree, { A: true })).toEqual(['A', 'A/1', 'A/2', 'B']);
  expect(visibleFolders(tree, {})).toEqual(['A', 'B']);
  expect(visibleFolders(tree, { A: true, 'A/1': true })).toEqual(['A', 'A/1', 'A/1/hidden', 'A/2', 'B']);
});
