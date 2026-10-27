// E-2 (readiness audit): a preset or a dice roll cannot write a param outside its def's range.
import { describe, expect, it } from 'vitest';
import { getDoc, projectStore, setParams } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';
import { defOf } from '../src/engine';

describe('setParams clamps (E-2)', () => {
  it('values past min / max land on the bound; in-range values and non-numbers pass through', () => {
    projectStore.set({ doc: demoProject(), past: [], future: [] });
    const b = getDoc().timeline.blocks.find((x) => x.graph.nodes.some((n) => defOf(n.kind)?.params.some((p) => p.min !== undefined && p.max !== undefined)))!;
    const n = b.graph.nodes.find((x) => defOf(x.kind)?.params.some((p) => p.min !== undefined && p.max !== undefined))!;
    const p = defOf(n.kind)!.params.find((x) => x.min !== undefined && x.max !== undefined)!;
    setParams(b.id, n.id, { [p.key]: p.max! + 1000 }, 'preset');
    const at = () => getDoc().timeline.blocks.find((x) => x.id === b.id)!.graph.nodes.find((x) => x.id === n.id)!.params[p.key];
    expect(at()).toBe(p.max);
    setParams(b.id, n.id, { [p.key]: p.min! - 1000 }, 'dice');
    expect(at()).toBe(p.min);
    const mid = (p.min! + p.max!) / 2;
    setParams(b.id, n.id, { [p.key]: mid }, 'preset');
    expect(at()).toBe(mid);
  });
});
