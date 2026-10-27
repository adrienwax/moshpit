// The clip library: a disposable SQLite index of the video files under the library roots, with
// probes cached against size + mtime. Ported from EDENA's scan.js (564ede8): node:sqlite with no
// JSON fallback (at 30k+ rows a JSON store is a hang), an opendir walk with skip lists, batched
// transactions, the synchronous `running` claim, and tags.js's keyOf path keys. What is new is the
// clip-library half: video files only, ffprobe metadata cached per file, probed lazily per folder,
// ratings and tags, deleted files dropped on rescan. Disposable cache scope (L13): delete and rescan.

import { opendir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { MoshpitError, type SourceProbe } from '@moshpit/core';
import { probe } from '../conform/conform';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mxf', '.mpg', '.mpeg', '.wmv', '.ts', '.m2ts']);
const SKIP = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);
const BATCH = 2000;

/** EDENA tags.js keyOf: one join key per path on a case-insensitive filesystem. */
export const keyOf = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/**
 * Is `child` the folder `root` or inside it? Whole path segments only (bug hunt: a plain prefix
 * put D:\Videos-old under D:\Videos). Case-insensitive, either slash, trailing separators ignored.
 */
export function isUnder(child: string, root: string): boolean {
  const c = keyOf(path.resolve(child)).replace(/\/+$/, ''), r = keyOf(path.resolve(root)).replace(/\/+$/, '');
  return c === r || c.startsWith(r + '/');
}

interface Row { path: string; real: string; folder: string; name: string; size: number; mtime: number; probe: string | null; probed_size: number | null; probed_mtime: number | null; rating: number; tags: string; fail: string | null }

export interface IndexedClip { path: string; name: string; folder: string; size: number; probe: SourceProbe | null; rating: number; tags: string[]; pass: true | { code: string } }
export interface IndexedFolder { path: string; name: string; count: number; children: IndexedFolder[] }

type Db = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown }; close(): void };

export class LibraryIndex {
  private db: Db;
  private running = false;
  constructor(file: string, private ffmpeg?: string) {
    let sqlite: { DatabaseSync: new (f: string) => Db };
    try { sqlite = (typeof require === 'function' ? require : createRequire(path.join(process.cwd(), 'index.js')))('node:sqlite'); }
    catch (e) { throw new MoshpitError('INTERNAL', { why: 'node:sqlite not available: the library index has no fallback by design' }, e); }
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clips (
        path TEXT PRIMARY KEY, real TEXT NOT NULL, root TEXT NOT NULL, folder TEXT NOT NULL, name TEXT NOT NULL,
        size INTEGER NOT NULL, mtime INTEGER NOT NULL, seen INTEGER NOT NULL,
        probe TEXT, probed_size INTEGER, probed_mtime INTEGER, fail TEXT,
        rating INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS clips_folder ON clips(folder);
      CREATE INDEX IF NOT EXISTS clips_root ON clips(root);`);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /**
   * Walk a root, upsert every video file, drop rows for files that are gone. Ratings and tags survive.
   * `shallow`: this folder's own files only (a folder opened by navigation, outside the roots).
   */
  async scan(rootIn: string, onProgress?: (files: number) => void, signal?: AbortSignal, shallow = false): Promise<{ files: number; unreadable: number; removed: number }> {
    const root = path.resolve(rootIn);
    if (this.running) throw new MoshpitError('INTERNAL', { why: 'a library scan is already running' });
    this.running = true; // claimed before the first await (EDENA's fix for two scans in one stat)
    const stamp = Date.now(), rootKey = keyOf(root);
    // A full walk claims its rows for its root (bug hunt: a folder first indexed shallowly kept its own
    // root, so it left the tree and its deleted clips were never pruned); a shallow scan does not.
    const up = this.db.prepare(`INSERT INTO clips(path, real, root, folder, name, size, mtime, seen) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET real = excluded.real, folder = excluded.folder, size = excluded.size, mtime = excluded.mtime, seen = excluded.seen${shallow ? '' : ', root = excluded.root'}`);
    let files = 0, unreadable = 0;
    let batch: unknown[][] = [];
    const flush = () => { const b = batch; batch = []; this.tx(() => { for (const r of b) up.run(...r); }); onProgress?.(files); };
    try {
      const walk = async (dir: string): Promise<void> => {
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        let d;
        try { d = await opendir(dir); } catch { unreadable++; return; }
        const subdirs: string[] = [], vids: string[] = [];
        for await (const e of d) {
          if (e.isDirectory()) { if (!SKIP.has(e.name.toLowerCase())) subdirs.push(path.join(dir, e.name)); }
          else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) vids.push(e.name);
        }
        // stat in parallel batches: one sequential stat per file was the walk's whole cost.
        for (let i = 0; i < vids.length; i += 32) {
          const sts = await Promise.all(vids.slice(i, i + 32).map((n) => stat(path.join(dir, n)).catch(() => null)));
          sts.forEach((st, j) => {
            if (!st) { unreadable++; return; }
            const name = vids[i + j], full = path.join(dir, name);
            batch.push([keyOf(full), full, rootKey, keyOf(dir), name, st.size, Math.floor(st.mtimeMs), stamp]);
            files++;
          });
          if (batch.length >= BATCH) flush();
        }
        if (!shallow) for (const s2 of subdirs) await walk(s2);
      };
      await walk(root);
      if (batch.length) flush();
      const removed = Number((this.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE root = ? AND seen < ?').get(rootKey, stamp) as { n: number }).n);
      this.db.prepare('DELETE FROM clips WHERE root = ? AND seen < ?').run(rootKey, stamp);
      return { files, unreadable, removed };
    } finally { this.running = false; }
  }

  /** Folder tree under a root, counting clips per folder. */
  folders(rootIn: string): IndexedFolder {
    const root = path.resolve(rootIn);
    const rows = this.db.prepare('SELECT folder, COUNT(*) AS n, MIN(real) AS sample FROM clips WHERE root = ? GROUP BY folder').all(keyOf(root)) as { folder: string; n: number; sample: string }[];
    const top: IndexedFolder = { path: root, name: path.basename(root) || root, count: 0, children: [] };
    const byKey = new Map<string, IndexedFolder>([[keyOf(root), top]]);
    const ensure = (real: string): IndexedFolder => {
      const k = keyOf(real);
      const hit = byKey.get(k);
      if (hit) return hit;
      const f: IndexedFolder = { path: real, name: path.basename(real), count: 0, children: [] };
      byKey.set(k, f);
      // Never climb past the filesystem root (a folder outside the scanned root hangs off the top).
      (path.dirname(real) === real ? top : ensure(path.dirname(real))).children.push(f);
      return f;
    };
    for (const r of rows) ensure(path.dirname(r.sample)).count += Number(r.n);
    return top;
  }

  /**
   * A folder's clips. Probes run here, lazily, for rows never probed or changed since (size or
   * mtime moved): probing 30k files up front would take hours; a folder at a time is seconds.
   */
  async clips(folder: string, concurrency = 4): Promise<IndexedClip[]> {
    const rows = this.db.prepare('SELECT * FROM clips WHERE folder = ? ORDER BY name').all(keyOf(folder)) as Row[];
    const stale = rows.filter((r) => r.probed_size !== r.size || r.probed_mtime !== r.mtime);
    const save = this.db.prepare('UPDATE clips SET probe = ?, fail = ?, probed_size = ?, probed_mtime = ? WHERE path = ?');
    for (let i = 0; i < stale.length; i += concurrency) {
      await Promise.all(stale.slice(i, i + concurrency).map(async (r) => {
        try { r.probe = JSON.stringify(await probe(r.real, this.ffmpeg)); r.fail = null; }
        catch (e) { r.probe = null; r.fail = e instanceof MoshpitError ? e.code : 'MEDIA_UNREADABLE'; }
        save.run(r.probe, r.fail, r.size, r.mtime, r.path);
      }));
    }
    return rows.map((r) => ({ path: r.real, name: r.name, folder: folder, size: r.size, probe: r.probe ? JSON.parse(r.probe) : null, rating: r.rating, tags: JSON.parse(r.tags), pass: r.fail ? { code: r.fail } : true }));
  }

  setRating(file: string, rating: number): void { this.db.prepare('UPDATE clips SET rating = ? WHERE path = ?').run(Math.max(0, Math.min(5, Math.round(rating))), keyOf(file)); }
  setTags(file: string, tags: string[]): void { this.db.prepare('UPDATE clips SET tags = ? WHERE path = ?').run(JSON.stringify([...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort()), keyOf(file)); }
  close(): void { this.db.close(); }
}
