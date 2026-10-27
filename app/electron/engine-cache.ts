// The engine's disk cache lives in userData/engine-cache. Until 3.1 it was userData/cache, which on
// a case-insensitive file system is the same folder as Chromium's own HTTP "Cache", so the HUD's
// CACHE readout and any "clear cache" counted Chromium's files too. This moves the engine's folders
// once, and rebases the absolute conform paths a project saved before the move still holds.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { ProjectDoc } from '@moshpit/engine';
import { overlaps } from '../../core/src/paths';

/** What the engine writes under its cache dir (EngineService, filmstrip, LibraryIndex). */
const ENGINE_ENTRIES = ['conform', 'engine', 'filmstrips', 'verify', 'tmp', 'library.db', 'library.db-wal', 'library.db-shm'];

export const engineCacheDir = (userData: string) => path.join(userData, 'engine-cache');

/**
 * Where the engine writes conforms, freezes and filmstrips (Waxy, 2026-10-07: off C:). In order:
 * MOSHPIT_ENGINE_CACHE; test runs keep their own profile's cache (MOSHPIT_CACHE_IN_PROFILE);
 * Settings → Folders → cache, under `engine`, when its drive exists; else the profile.
 * Conforms already in the profile stay valid: projects point at them by absolute path.
 */
export function engineCacheRoot(userData: string, settingsCache: string | undefined, env = process.env, mediaRoots: string[] = []): string {
  if (env.MOSHPIT_ENGINE_CACHE) return env.MOSHPIT_ENGINE_CACHE;
  if (env.MOSHPIT_CACHE_IN_PROFILE) return engineCacheDir(userData);
  // Phase 0.4: a cache inside a media root (or holding one) would mix Moshpit's files with footage.
  const set = settingsCache?.trim();
  if (set && mediaRoots.some((r) => overlaps(set, r))) {
    console.warn(`engine cache: ${set} overlaps a media root; using the profile instead`);
    return engineCacheDir(userData);
  }
  if (!set) return engineCacheDir(userData);
  const want = set;
  const drive = path.parse(path.resolve(want)).root;
  if (path.isAbsolute(want) && existsSync(drive)) {
    const dir = path.join(want, 'engine');
    try { mkdirSync(dir, { recursive: true }); return dir; } catch { /* unwritable: fall back */ }
  }
  return engineCacheDir(userData);
}
const legacyDir = (userData: string) => path.join(userData, 'cache');

/** Settings → Folders as saved on disk. Main reads them itself: a path the renderer sends is never trusted for a delete. */
export function settingsPaths(userData: string): Record<string, string> {
  try {
    const p = JSON.parse(readFileSync(path.join(userData, 'config', 'settings.json'), 'utf8'))?.paths;
    return p && typeof p === 'object' ? (Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'string')) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The library roots: Settings → Media root(s), ';'-separated; empty means the Videos folder. */
export function mediaRootsOf(media: string | undefined, videos: string): string[] {
  const r = (media ?? '').split(';').map((x) => x.trim()).filter(Boolean);
  return r.length ? r : [videos];
}

/**
 * The transient preview slot (F5): `<Settings cache>\preview`, fixed by main. A cache setting that is
 * empty, relative or overlapping a media root falls back to the profile, so clearing previews can
 * never reach a footage folder (or `\preview` at a drive root, which an empty setting used to mean).
 */
export function previewDir(userData: string, settingsCache: string | undefined, mediaRoots: string[]): string {
  const c = settingsCache?.trim();
  const base = c && path.isAbsolute(c) && !mediaRoots.some((r) => overlaps(c, r)) ? c : engineCacheDir(userData);
  return path.join(base, 'preview');
}

/** One-time move; an entry already present in the new place is left where it is. Returns what moved. */
export function migrateEngineCache(userData: string): string[] {
  const from = legacyDir(userData), to = engineCacheDir(userData);
  mkdirSync(to, { recursive: true });
  const moved: string[] = [];
  for (const e of ENGINE_ENTRIES) {
    const a = path.join(from, e), b = path.join(to, e);
    if (!existsSync(a) || existsSync(b)) continue;
    try { renameSync(a, b); moved.push(e); } catch (err) { console.error(`engine cache: could not move ${e}:`, err); }
  }
  return moved;
}

/**
 * Partial encodes left by a process that is gone (the app closed mid-master): `<stem>.tmp-<pid>-<hex>.mp4`.
 * The cache only ever reads finished names, so these are dead weight; a 48 min master left 7.8 GB
 * on C: (2026-10-07). A file whose pid still runs (another Moshpit window) is left alone.
 */
export function sweepPartialEncodes(dir: string, alive: (pid: number) => boolean = isAlive): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const name of readdirSync(dir)) {
    const m = /\.tmp-(\d+)-[0-9a-f]+\.(mp4|json)$/.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    const p = path.join(dir, name);
    try { bytes += statSize(p); rmSync(p, { force: true }); files++; } catch { /* in use: next start */ }
  }
  return { files, bytes };
}
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
const statSize = (p: string) => { try { return statSync(p).size; } catch { return 0; } };

/** Point conform + proxy paths under the legacy dir at the new one, only where the old file is gone and the new one exists. */
export function rebaseCachePaths<T extends ProjectDoc | undefined>(doc: T, userData: string): T {
  if (!doc) return doc;
  const from = legacyDir(userData) + path.sep, to = engineCacheDir(userData) + path.sep;
  const fix = (p: string) => {
    if (!p.toLowerCase().startsWith(from.toLowerCase()) || existsSync(p)) return p;
    const q = to + p.slice(from.length);
    return existsSync(q) ? q : p;
  };
  for (const c of doc.resources.conforms) {
    c.path = fix(c.path);
    if (c.proxy) c.proxy.path = fix(c.proxy.path);
  }
  return doc;
}

/**
 * Keep the freeze cache under `capBytes` (pushback 3, Waxy agreed): oldest first, never a freeze
 * the open project uses. An evicted freeze is safe: the engine reports it missing and the block
 * offers to re-freeze (L25, D5). Returns what was removed.
 */
export function capFreezes(dir: string, capBytes: number, keep: Set<string>): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  const files = readdirSync(dir).filter((n) => n.endsWith('.rgba')).map((n) => {
    const p = path.join(dir, n);
    try { const st = statSync(p); return { p, key: n.slice(0, -5), size: st.size, t: st.mtimeMs }; } catch { return null; }
  }).filter((f): f is { p: string; key: string; size: number; t: number } => !!f);
  let total = files.reduce((a, f) => a + f.size, 0);
  let n = 0, freed = 0;
  for (const f of files.sort((a, b) => a.t - b.t)) {
    if (total <= capBytes) break;
    if (keep.has(f.key)) continue;
    try { rmSync(f.p, { force: true }); total -= f.size; freed += f.size; n++; } catch { /* open: next pass */ }
  }
  return { files: n, bytes: freed };
}
