import type { LibraryClip, LibraryFolder } from '../../engine';
export type Sort = 'name' | 'duration' | 'rating' | 'size';
export const CHIPS = [
  { k: 'stars', label: '★ 3+', test: (c: LibraryClip) => c.rating >= 3 },
  { k: 'motion', label: 'motion', test: (c: LibraryClip) => c.tags.includes('motion') },
  { k: 'hap', label: 'HAP', test: (c: LibraryClip) => c.probe.codec.startsWith('HAP') },
  { k: 'prores', label: 'ProRes', test: (c: LibraryClip) => c.probe.codec.startsWith('ProRes') },
  { k: 'pass', label: 'pass ✓', test: (c: LibraryClip) => c.pass === true },
  { k: 'project', label: 'in project', test: (c: LibraryClip) => !!c.sourceId },
];


/** One model for the grid and hardware clip navigation. Unknown saved filters are ignored. */
export function visibleClips(clips: LibraryClip[], q = '', chips: string[] = [], sort: Sort = 'name'): LibraryClip[] {
  const needle = q.trim().toLowerCase();
  const list = clips.filter(c => (!needle || `${c.name} ${c.probe.codec} ${c.tags.join(' ')}`.toLowerCase().includes(needle)) && chips.every(k => CHIPS.find(x => x.k === k)?.test(c) ?? true));
  const by: Record<Sort, (a: LibraryClip, b: LibraryClip) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    duration: (a, b) => b.probe.durationSec - a.probe.durationSec,
    rating: (a, b) => b.rating - a.rating,
    size: (a, b) => b.probe.width * b.probe.height - a.probe.width * a.probe.height,
  };
  return [...list].sort(by[sort] ?? by.name);
}

/** Exactly the expanded library tree on screen; recency changes cannot reorder this list. */
export function visibleFolders(folders: LibraryFolder[], open: Record<string, boolean>): string[] {
  return folders.flatMap(folder => [folder.path, ...(open[folder.path] ? visibleFolders(folder.children, open) : [])]);
}
