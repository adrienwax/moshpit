import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MIGRATIONS, parseProject, saveProjectFile, loadProjectFile, serializeProject } from '../src/project/io';
import { newBlock, newProject, withChain, duplicateBlock } from '../src/project/build';
import { compileBlockGraph } from '../src/graph/stage2';
import type { ProjectDoc, SourceId } from '../src/model';
import { CURRENT_VERSIONS } from '../src/model';

const sample = (): ProjectDoc => {
  const d = newProject('round trip');
  d.timeline.blocks = [withChain(newBlock('picture', 'S' as SourceId, 0, 90), [{ kind: 'fx.plane-desync' }, { kind: 'fx.feedback' }])];
  return d;
};

// The real steps (graph 1 → 2) are restored after each test; a test's own golden step is dropped.
const REAL = Object.fromEntries(Object.entries(MIGRATIONS).map(([k, v]) => [k, { ...v }]));
afterEach(() => { for (const s of Object.keys(MIGRATIONS) as (keyof typeof MIGRATIONS)[]) MIGRATIONS[s] = { ...REAL[s] }; });

describe('project persistence (L12–L14)', () => {
  it('round-trips byte for byte', () => {
    const text = serializeProject(sample());
    expect(serializeProject(parseProject(text).doc)).toBe(text);
  });

  it('preserves unknown fields and unknown node kinds from a newer build, verbatim (C4: new → old → save → new)', () => {
    const d = sample() as ProjectDoc & Record<string, unknown>;
    d.versions = { ...d.versions, graph: 7 };
    d.futureSection = { lanes: [1, 2, 3] };
    const blk = d.timeline.blocks[0] as typeof d.timeline.blocks[0] & Record<string, unknown>;
    blk.automation = { curve: 'ease' };
    blk.graph.nodes.push({ id: 'n-future' as never, kind: 'fx.not-invented-yet' as never, defVersion: 3, params: { q: 9 }, bindings: {}, position: { x: 1, y: 2 }, shape: 'hex' } as never);
    const newer = serializeProject(d);
    const { doc, warnings } = parseProject(newer);
    expect(warnings.map((w) => w.code)).toEqual(['PROJECT_TOO_NEW']);
    expect(serializeProject(doc)).toBe(newer); // saved back unchanged
    const plan = compileBlockGraph(doc.timeline.blocks[0].id, doc.timeline.blocks[0].graph);
    expect(plan.warnings.map((w) => w.code)).toContain('NODE_UNKNOWN_KIND'); // runs as pass-through
  });

  it('migrates a section on a copy, never mutating what was read (golden step)', () => {
    const old = sample();
    old.versions = { ...old.versions, project: 0 };
    (old.settings as Record<string, unknown>).fpsFloat = 29.97; // a v0 shape the step removes
    const text = serializeProject(old);
    const input = JSON.parse(text);
    MIGRATIONS.project[0] = (d) => { const s = { ...(d.settings as object) } as Record<string, unknown>; delete s.fpsFloat; return { ...d, settings: s }; };
    const { doc, migrated } = parseProject(text);
    expect(migrated).toEqual({ project: [0, 1], graph: [1, 2] }); // a container-free project is written at graph 1 (D3)
    expect(doc.versions.project).toBe(CURRENT_VERSIONS.project);
    expect((doc.settings as Record<string, unknown>).fpsFloat).toBeUndefined();
    expect(JSON.parse(text)).toEqual(input);
  });

  it('refuses a version with no registered migration, with a code', () => {
    const old = sample();
    old.versions = { ...old.versions, resources: 0 };
    expect(() => parseProject(serializeProject(old))).toThrowError(/PROJECT_MIGRATION_FAILED/);
  });

  it('refuses things that are not projects', () => {
    expect(() => parseProject('{')).toThrowError(/PROJECT_PARSE/);
    expect(() => parseProject('{"format":"other"}')).toThrowError(/PROJECT_PARSE/);
    expect(() => parseProject(JSON.stringify({ ...sample(), timeline: {} }))).toThrowError(/PROJECT_PARSE/);
  });

  it('saves atomically and loads back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-'));
    const file = path.join(dir, 'p.moshpit.json');
    const d = sample();
    saveProjectFile(file, d);
    expect(fs.readdirSync(dir)).toEqual(['p.moshpit.json']);
    expect(loadProjectFile(file).doc).toEqual(d);
    fs.rmSync(dir, { recursive: true });
  });

  it('duplicates a block with fresh identities throughout (L6)', () => {
    const b = sample().timeline.blocks[0];
    const c = duplicateBlock(b);
    expect(c.id).not.toBe(b.id);
    const ids = new Set(b.graph.nodes.map((n) => n.id));
    expect(c.graph.nodes.every((n) => !ids.has(n.id))).toBe(true);
    expect(compileBlockGraph(c.id, c.graph).ok).toBe(true);
  });
});
