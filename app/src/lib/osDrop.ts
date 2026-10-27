// Dropping folders and video files from the OS (Waxy: "drop a folder here" did nothing, nor did a file).
// Nothing read an OS drop before: the handlers only took the app's own drags (a folder from the tree,
// a clip from the grid). Electron 43 also removed File.path: a dropped file's real path comes from
// webUtils.getPathForFile, which the preload exposes as moshpitHost.pathOf. The paths are read while
// the event is live (its dataTransfer empties when the handler returns); folder vs file is then
// asked of the engine (listDir answers for a folder, refuses a file).
import { engine } from '../engine';
import { host } from '../host';
import { setUi } from '../state/ui';
import { toast } from '../qol/qol';

const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mpg|mpeg|wmv|ts|m2ts)$/i;
export const folderOf = (p: string) => {
  const f = p.replace(/[\\/][^\\/]*$/, '') || p;
  return /^[A-Za-z]:$/.test(f) ? `${f}\\` : f; // a clip at a drive root: "D:\\", not "D:" (the current folder on D)
};
const nameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** True for a drag carrying files from the OS (not the app's own drags). */
export const isOsDrop = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

/** The dropped paths, read now (call it inside the drop handler, before any await). */
export const droppedPaths = (e: { dataTransfer: DataTransfer | null }): string[] =>
  [...(e.dataTransfer?.files ?? [])].map((f) => host.pathOf?.(f) ?? '').filter(Boolean);

/** Split dropped paths into folders, video files and anything else. */
export async function classify(paths: string[]): Promise<{ dirs: string[]; videos: string[]; other: string[] }> {
  const out = { dirs: [] as string[], videos: [] as string[], other: [] as string[] };
  for (const p of paths) {
    try { await engine.listDir(p); out.dirs.push(p); } catch { (VIDEO.test(p) ? out.videos : out.other).push(p); }
  }
  return out;
}

/**
 * Open what was dropped in Source: a folder opens in the navigator; a video file opens its folder
 * with that clip selected, ready to mark IN / OUT and send to A or B.
 */
export async function openDropped(paths: string[]): Promise<{ dirs: string[]; videos: string[] }> {
  if (!paths.length) {
    toast("Couldn't read a path from that drop. Drop a folder or video files from Explorer.", { kind: 'warn' });
    return { dirs: [], videos: [] };
  }
  const { dirs, videos, other } = await classify(paths);
  if (dirs.length) {
    setUi({ ws: 'browse', folder: dirs[0] });
    toast(`Opened ${nameOf(dirs[0])} in Source`, { kind: 'ok' });
  } else if (videos.length) {
    setUi({ ws: 'browse', folder: folderOf(videos[0]), libClip: videos[0] });
    toast(`Opened ${nameOf(videos[0])} in Source: mark IN / OUT, then send it to A or B${videos.length > 1 ? ` (its folder holds the other ${videos.length - 1} too)` : ''}`, { kind: 'ok' });
  } else if (other.length) {
    toast(`Moshpit opens folders and video files; ${nameOf(other[0])} is neither.`, { kind: 'warn' });
  }
  return { dirs, videos };
}
