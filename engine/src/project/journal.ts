// L14: autosave writes only the mutable document as a history-delta journal; crash recovery replays
// the journal onto the last saved project. The hashed .pack is never written here.
//
//   <project>.moshpit.json            the last explicit save (atomic, project/io.ts)
//   <project>.moshpit.json.journal    NDJSON: a header naming the save it extends, then one delta per edit
//
// A delta is a list of path replacements between two snapshots: small for the edits a person makes
// (a param drag, a block trim), and exact. A crash mid-append leaves a torn last line, which
// recovery ignores: the previous edit is the newest one kept.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { ProjectDoc } from '@moshpit/core';
import { parseProject, saveProjectFile, serializeProject } from './io';

export type Path = (string | number)[];
/** Replace the value at `p`, delete the key, or set an array's length (truncation). */
export interface Change { p: Path; v?: unknown; del?: true; len?: number }

/** Replacements that turn `a` into `b`. Arrays diff by index, with appends and a truncation for length changes. */
export function diff(a: unknown, b: unknown, path: Path = [], out: Change[] = []): Change[] {
  if (a === b) return out;
  const ao = a !== null && typeof a === 'object', bo = b !== null && typeof b === 'object';
  if (!ao || !bo || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ p: path, v: b });
    return out;
  }
  if (Array.isArray(a)) {
    const A = a as unknown[], B = b as unknown[];
    for (let i = 0; i < Math.min(A.length, B.length); i++) diff(A[i], B[i], [...path, i], out);
    for (let i = A.length; i < B.length; i++) out.push({ p: [...path, i], v: B[i] });
    if (B.length < A.length) out.push({ p: path, len: B.length });
    return out;
  }
  const A = a as Record<string, unknown>, B = b as Record<string, unknown>;
  for (const k of Object.keys(A)) if (!(k in B)) out.push({ p: [...path, k], del: true });
  for (const k of Object.keys(B)) diff(A[k], B[k], [...path, k], out);
  return out;
}

export function apply<T>(doc: T, changes: Change[]): T {
  let root: unknown = structuredClone(doc);
  for (const c of changes) {
    if (!c.p.length && c.len === undefined) { root = structuredClone(c.v); continue; }
    if (c.len !== undefined) { let t = root as Record<string | number, unknown>; for (const k of c.p) t = t[k] as Record<string | number, unknown>; (t as unknown as unknown[]).length = c.len; continue; }
    let o = root as Record<string | number, unknown>;
    for (const k of c.p.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
    const last = c.p[c.p.length - 1];
    if (c.del) delete o[last]; else o[last] = structuredClone(c.v);
  }
  return root as T;
}

/** Write and flush to the disk before returning. */
function durableWrite(file: string, text: string, flag: 'w' | 'a') {
  const fd = fs.openSync(file, flag);
  try {
    fs.writeSync(fd, text);
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

export class Autosaver {
  private last: ProjectDoc;
  private seq = 0;
  constructor(private file: string, saved: ProjectDoc) {
    this.last = structuredClone(saved);
    if (!fs.existsSync(this.journal)) this.reset(serializeProject(saved));
  }
  get journal(): string { return `${this.file}.journal`; }

  // Phase 0.3: the header is written atomically (temp + rename) and every append reaches the disk
  // before commit returns (fdatasync), so a power cut or a killed process keeps every edit it was told.
  private reset(savedText: string): void {
    const tmp = `${this.journal}.tmp`;
    durableWrite(tmp, JSON.stringify({ journal: 1, base: hash(savedText) }) + '\n', 'w');
    fs.renameSync(tmp, this.journal);
    this.seq = 0;
  }

  /** One committed edit: append its delta. Cheap enough for every undo step (L14). */
  commit(next: ProjectDoc): number {
    const d = diff(this.last, next);
    if (!d.length) return 0;
    durableWrite(this.journal, JSON.stringify({ seq: ++this.seq, at: Date.now(), d }) + '\n', 'a');
    this.last = structuredClone(next);
    return d.length;
  }

  /** An explicit save: write the project atomically and start a fresh journal against it. */
  save(doc: ProjectDoc): void {
    saveProjectFile(this.file, doc);
    this.last = structuredClone(doc);
    this.reset(serializeProject(doc));
  }
}

export interface Recovery { doc: ProjectDoc; replayed: number; tornTail: boolean; stale: boolean }

/**
 * After a crash: the saved project plus every intact journal entry. `stale` means the journal was
 * written against a different save (the project was saved by another session), so nothing is
 * replayed onto it.
 */
export function recover(file: string): Recovery | null {
  const jf = `${file}.journal`;
  if (!fs.existsSync(jf)) return null;
  const text = fs.readFileSync(file, 'utf8');
  let doc = parseProject(text).doc;
  const lines = fs.readFileSync(jf, 'utf8').split('\n').filter(Boolean);
  let head: { base?: string } = {};
  try { head = JSON.parse(lines[0]); } catch { return { doc, replayed: 0, tornTail: true, stale: false }; }
  if (head.base !== hash(text)) return { doc, replayed: 0, tornTail: false, stale: true };
  let replayed = 0, tornTail = false;
  for (const line of lines.slice(1)) {
    let e: { d: Change[] };
    try { e = JSON.parse(line); } catch { tornTail = true; break; }
    doc = apply(doc, e.d);
    replayed++;
  }
  return { doc, replayed, tornTail, stale: false };
}
