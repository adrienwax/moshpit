// Save → reopen → identical, through the engine's own persistence functions (the ones the main
// process runs) and through the app's store. Unknown fields from a newer build must survive (C4).
import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject } from '../../engine/src/project/io';
import { emptyDoc, getDoc, projectStore, setParam, undo } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import type { ProjectDoc } from '@moshpit/engine';

/** A project as a newer Moshpit might write it: extra fields at every level. */
function withFutureFields(): ProjectDoc {
  const d = demoProject() as ProjectDoc & Record<string, unknown>;
  d.futureTopLevel = { keep: ['me', 1, true] };
  (d.settings as Record<string, unknown>).hdrMode = 'pq';
  const b = d.timeline.blocks[1] as unknown as Record<string, unknown>;
  b.futureBlockField = 42;
  const n = d.timeline.blocks[1].graph.nodes[1] as unknown as Record<string, unknown>;
  n.futureNodeField = { nested: { deep: 'x' } };
  (d.modulators as Record<string, unknown>).envelopes = [{ id: 'env-1' }];
  return d;
}

describe('project round-trip', () => {
  it('serialize → parse → serialize is byte-identical, unknown fields included', () => {
    const text = serializeProject(withFutureFields());
    const { doc, warnings, migrated } = parseProject(text);
    expect(warnings).toEqual([]);
    expect(migrated).toEqual({ graph: [1, 2] }); // no container → written at graph 1, read up to 2 (D3)
    expect(serializeProject(doc)).toBe(text);
    expect((doc as unknown as Record<string, unknown>).futureTopLevel).toEqual({ keep: ['me', 1, true] });
  });

  it('loading into the store, editing and undoing saves back byte-identical', () => {
    const text = serializeProject(withFutureFields());
    projectStore.set({ doc: parseProject(text).doc, past: [], future: [] });
    const blk = getDoc().timeline.blocks[1];
    const node = blk.graph.nodes[2]; // a node with params
    const key = Object.keys(node.params)[0];
    const v = node.params[key];
    setParam(blk.id, node.id, key, typeof v === 'number' ? v + 0.001 : v);
    expect(serializeProject(getDoc())).not.toBe(text);
    // An edit keeps every unknown field on the edited path.
    expect((getDoc().timeline.blocks[1].graph.nodes[1] as unknown as Record<string, unknown>).futureNodeField).toEqual({ nested: { deep: 'x' } });
    undo();
    expect(serializeProject(getDoc())).toBe(text);
  });

  it('a newer section version loads with PROJECT_TOO_NEW and saves back unchanged', () => {
    const d = withFutureFields();
    d.versions = { ...d.versions, graph: d.versions.graph + 1 };
    const text = serializeProject(d);
    const { doc, warnings } = parseProject(text);
    expect(warnings.map((w) => w.code)).toEqual(['PROJECT_TOO_NEW']);
    expect(serializeProject(doc)).toBe(text);
  });

  it('a new project is a valid document', () => {
    const text = serializeProject(emptyDoc());
    expect(() => parseProject(text)).not.toThrow();
  });
});
