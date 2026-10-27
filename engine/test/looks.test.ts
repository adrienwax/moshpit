// D5: looks replace the Recipe fragment API. A library entry is a container definition; placing one
// stamps an owned copy with fresh ids; a look file is untrusted and is clamped and checked on import.
import { describe, expect, it } from 'vitest';
import type { BlockGraph, EdgeId, NodeId, NodeInstance, PortKey, SourceId } from '@moshpit/core';
import { lookFile, lookFrom, stampLook, validateLook } from '../src/project/looks';
import { collapseSelection, inlineContainers } from '../src/graph/container';
import { compileBlockGraph } from '../src/graph/stage2';
import { newBlock, withChain } from '../src/project/build';
import { DEF_BY_KIND } from '../src/nodes/defs';

const portType = (n: NodeInstance, port: PortKey) => DEF_BY_KIND.get(n.kind)?.outputs.find((p) => p.key === port)?.type;
const ids = () => { let k = 0; return { container: 'C' as NodeId, groupIn: 'GI' as NodeId, groupOut: 'GO' as NodeId, edge: () => `x${++k}` as EdgeId }; };

function vhsLook() {
  const b = withChain(newBlock('picture', 'S' as SourceId, 0, 90), [{ kind: 'fx.chroma-drift' }, { kind: 'fx.posterize', params: { levels: 5 } }]);
  const pick = b.graph.nodes.filter((n) => n.kind === 'fx.chroma-drift' || n.kind === 'fx.posterize').map((n) => n.id);
  const g = collapseSelection(b.graph, pick, ids(), portType);
  const box = g.nodes.find((n) => n.id === 'C')!;
  const post = box.body!.graph.nodes.find((n) => n.kind === 'fx.posterize')!;
  box.body!.macros = [{ key: 'crunch' as never, label: 'Crunch', help: 'Fewer levels', min: 0, max: 1, default: 0, target: { node: post.id, param: 'levels' as never }, map: { from: 16, to: 2, curve: 'linear' } }];
  return { b, g, box, post };
}

describe('looks (D5: library definitions, stamped as owned copies)', () => {
  it('lookFrom copies a container into a definition; a file round-trips through validateLook', () => {
    const { box } = vhsLook();
    const def = lookFrom(box, '  VHS  ', { look: 'Decay & Corrupt' });
    expect([def.name, def.rev, def.look, def.body.macros.length]).toEqual(['VHS', 1, 'Decay & Corrupt', 1]);
    box.body!.graph.nodes[0].params.x = 1;
    expect(def.body.graph.nodes[0].params.x).toBeUndefined(); // a copy, not a link
    const back = validateLook(JSON.parse(JSON.stringify(lookFile(def))));
    expect(back).toEqual(def);
  });

  it('stamping gives fresh ids everywhere, remaps macro targets, records its origin, and compiles in a block', () => {
    const { b, g, box } = vhsLook();
    const def = lookFrom(box, 'VHS');
    const c = stampLook(def, { x: 10, y: 20 });
    const old = new Set(box.body!.graph.nodes.map((n) => n.id));
    expect(c.body!.graph.nodes.some((n) => old.has(n.id))).toBe(false);
    expect(c.body!.graph.nodes.some((n) => n.id === c.body!.macros[0].target.node)).toBe(true);
    expect(c.body!.origin).toEqual({ component: def.id, rev: 1 });
    // In place of the original container: same wiring, the stamped copy's own ids.
    const swapped: BlockGraph = { nodes: g.nodes.map((n) => (n.id === 'C' ? { ...c, id: 'C' as NodeId } : n)), edges: g.edges };
    expect(compileBlockGraph(b.id, swapped).ok).toBe(true);
    const flat = inlineContainers(swapped).graph;
    expect(flat.nodes.find((n) => n.kind === 'fx.posterize')!.params.levels).toBe(5); // macro unturned: as authored
    expect(stampLook(def, { x: 0, y: 0 }).body!.graph.nodes[0].id).not.toBe(c.body!.graph.nodes[0].id); // twice → two copies
  });

  it('validates untrusted files: clamps values, keeps unknown kinds, drops broken macros, refuses nesting', () => {
    const { box } = vhsLook();
    const file = JSON.parse(JSON.stringify(lookFile(lookFrom(box, 'VHS'))));
    const nodes = file.look.body.graph.nodes;
    nodes.find((n: NodeInstance) => n.kind === 'fx.posterize').params.levels = 999;
    nodes.push({ id: 'future', kind: 'fx.not-invented-yet', defVersion: 1, params: { q: 9 }, bindings: {}, position: { x: 0, y: 0 } });
    file.look.body.macros.push({ key: 'bad', label: 'x', min: 1, max: 0, default: 0, target: { node: 'nope', param: 'p' } });
    const v = validateLook(file);
    expect(v.body.graph.nodes.find((n) => n.kind === 'fx.posterize')!.params.levels).toBe(32);
    expect(v.body.graph.nodes.find((n) => n.id === 'future')!.params).toEqual({ q: 9 });
    expect(v.body.macros.map((m) => m.key)).toEqual(['crunch']);
    const nested = JSON.parse(JSON.stringify(file));
    nested.look.body.graph.nodes.push({ id: 'inner-box', kind: 'group.container', defVersion: 1, params: {}, bindings: {}, position: { x: 0, y: 0 }, body: file.look.body });
    expect(() => validateLook(nested)).toThrowError(/RECIPE_INVALID/);
    expect(() => validateLook({ schema: 'moshpit.recipe', version: 1 })).toThrowError(/RECIPE_INVALID/);
    // Audit P2: six macros at most, as exposeMacro: a hand-edited file with nine keeps the first six.
    const many = JSON.parse(JSON.stringify(file));
    const post = many.look.body.graph.nodes.find((n: NodeInstance) => n.kind === 'fx.posterize');
    many.look.body.macros = Array.from({ length: 9 }, (_, i) => ({ key: `m${i}`, label: `M${i}`, help: '', min: 0, max: 1, default: 0, target: { node: post.id, param: 'levels' } }));
    expect(validateLook(many).body.macros.map((m) => m.key)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    const noOut = JSON.parse(JSON.stringify(file));
    noOut.look.body.graph.nodes = noOut.look.body.graph.nodes.filter((n: NodeInstance) => n.kind !== 'group.out');
    expect(() => validateLook(noOut)).toThrowError(/RECIPE_INVALID/);
  });
  it('round-trips turned macros without changing authored reset defaults; old files still work', () => {
    const { box } = vhsLook();
    box.params.crunch = 0.75;
    const def = lookFrom(box, 'Tuned');
    const back = validateLook(JSON.parse(JSON.stringify(lookFile(def))));
    const copy = stampLook(back, { x: 0, y: 0 });
    expect(copy.params.crunch).toBe(0.75);
    expect(copy.body!.macros[0].default).toBe(0);
    copy.params.crunch = 0.1;
    expect(def.params!.crunch).toBe(0.75);
    const old = lookFile(def); delete old.look.params;
    const legacy = validateLook(JSON.parse(JSON.stringify(old)));
    expect(legacy.params).toBeUndefined();
    expect(stampLook(legacy, { x: 0, y: 0 }).params).toEqual({});
  });

  it('filters unknown/non-numeric macro positions and clamps imported values', () => {
    const { box } = vhsLook();
    const file = lookFile(lookFrom(box, 'Tuned'));
    file.look.params = { crunch: 900, unknown: 0.2 };
    expect(validateLook(file).params).toEqual({ crunch: 1 });
    file.look.params = { crunch: Number.NaN };
    expect(validateLook(file).params).toEqual({});
    file.look.params = { crunch: 'oops' };
    expect(validateLook(file).params).toEqual({});
  });

});
