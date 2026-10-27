// L12–L14: loading and saving the project document.
//
//   - Migrations are pure, deterministic, one-directional, per section, and run on a copy: the
//     document read from disk is never mutated (L12).
//   - Forward compatibility (C4): a document from a newer build loads with PROJECT_TOO_NEW;
//     every field and node kind this build does not know is kept verbatim and saved back as read.
//     Nothing here rebuilds an object by picking known fields.
//   - Saves are atomic: write a temp file, then rename (Moshpit 1 main.js:351 pattern), so a
//     crash mid-save never leaves a torn project.

import * as fs from 'node:fs';
import { MoshpitError } from '../errors';
import { CURRENT_VERSIONS, type ProjectDoc, type SectionVersions } from '@moshpit/core';

export type Section = keyof SectionVersions;
type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/**
 * The chain, per section: MIGRATIONS[section][n] upgrades that section from version n to n+1.
 * Empty in 3.0's first format; the harness below is exercised by the golden tests with a
 * registered test step, so the first real migration lands on proven plumbing.
 */
export const MIGRATIONS: Record<Section, Record<number, Migration>> = {
  project: {},
  // graph 1 → 2 (3.2 Phase 3): v2 only adds container nodes; a v1 graph is a valid v2 graph.
  graph: { 1: (doc) => doc },
  nodeDefs: {}, components: {}, resources: {},
};

const holdsContainer = (doc: ProjectDoc) => doc.timeline.blocks.some((b) => b.graph.nodes.some((n) => n.kind === 'group.container'));

/**
 * The section versions a document is written at. graph is 2 only when it holds a container (D3):
 * Moshpit 3.1 then opens it with PROJECT_TOO_NEW and keeps the containers verbatim; a project
 * without one stays graph 1 and opens in 3.1 as before.
 */
export function versionsToWrite(doc: ProjectDoc): SectionVersions {
  const v = doc.versions.graph;
  // A newer build's graph version is kept as read (C4); this build writes 1 or 2.
  return { ...doc.versions, graph: v > CURRENT_VERSIONS.graph ? v : holdsContainer(doc) ? 2 : 1 };
}

export interface LoadResult {
  doc: ProjectDoc;
  /** Structured, non-fatal: PROJECT_TOO_NEW, per-node warnings come from the compiler. */
  warnings: MoshpitError[];
  /** Section → [from, to] for every migration applied. */
  migrated: Partial<Record<Section, [number, number]>>;
}

export function parseProject(text: string, current: SectionVersions = CURRENT_VERSIONS): LoadResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new MoshpitError('PROJECT_PARSE', { why: 'not JSON' }, e); }
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== 'moshpit.project') throw new MoshpitError('PROJECT_PARSE', { why: 'not a Moshpit project' });
  const r = raw as Record<string, unknown>;
  const versions = r.versions as Partial<SectionVersions> | undefined;
  if (!versions || typeof versions !== 'object') throw new MoshpitError('PROJECT_PARSE', { why: 'no section versions' });
  let doc = structuredClone(r);
  const warnings: MoshpitError[] = [];
  const migrated: LoadResult['migrated'] = {};
  for (const section of Object.keys(current) as Section[]) {
    const have = versions[section];
    if (!Number.isInteger(have)) throw new MoshpitError('PROJECT_PARSE', { why: `bad version for ${section}`, value: have });
    if (have! > current[section]) { warnings.push(new MoshpitError('PROJECT_TOO_NEW', { section, file: have, app: current[section] })); continue; }
    let v = have!;
    while (v < current[section]) {
      const step = MIGRATIONS[section][v];
      if (!step) throw new MoshpitError('PROJECT_MIGRATION_FAILED', { section, from: v, why: 'no migration registered' });
      try { doc = step(doc); } catch (e) { throw new MoshpitError('PROJECT_MIGRATION_FAILED', { section, from: v }, e); }
      v++;
    }
    if (v !== have) { migrated[section] = [have!, v]; (doc.versions as SectionVersions)[section] = v; }
  }
  validate(doc as unknown as ProjectDoc);
  return { doc: doc as unknown as ProjectDoc, warnings, migrated };
}

/** The structural minimum a renderer relies on. Unknown fields are not an error. */
function validate(d: ProjectDoc): void {
  const need = (ok: unknown, why: string) => { if (!ok) throw new MoshpitError('PROJECT_PARSE', { why }); };
  need(d.settings && d.settings.fps && Number.isInteger(d.settings.fps.num) && Number.isInteger(d.settings.fps.den), 'settings.fps');
  need(Array.isArray(d.timeline?.blocks), 'timeline.blocks');
  need(Array.isArray(d.resources?.sources) && Array.isArray(d.resources?.conforms), 'resources');
  for (const b of d.timeline.blocks) need(b && typeof b.id === 'string' && Array.isArray(b.graph?.nodes) && Array.isArray(b.graph?.edges), `block ${b?.id}`);
  need(Array.isArray(d.modulators?.lfos), 'modulators.lfos');
}

/** Two-space JSON. Key order is the document's own, so an unchanged load saves back unchanged. */
export function serializeProject(doc: ProjectDoc): string {
  return JSON.stringify({ ...doc, versions: versionsToWrite(doc) }, null, 2) + '\n';
}

export function loadProjectFile(file: string): LoadResult {
  if (!fs.existsSync(file)) throw new MoshpitError('MEDIA_FILE_MISSING', { path: file });
  return parseProject(fs.readFileSync(file, 'utf8'));
}

export function saveProjectFile(file: string, doc: ProjectDoc): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeProject(doc));
  fs.renameSync(tmp, file);
}
