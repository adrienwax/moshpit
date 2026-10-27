import { describe, expect, it } from 'vitest';
import { compileBlockGraph, inlineContainers, type BlockGraph, type ComponentDef } from '@moshpit/engine';
import { nodeDefs } from '../src/engine';
import { entries } from '../src/lib/browse';
import { auditionGraph, auditionOf, endAudition, prepareAudition, startAudition } from '../src/state/audition';
import { applyAudition } from '../src/components/AuditionBar';
import { demoProject } from '../src/engine/mockProject';
import { addBlock, addSource, appendEffect, branchParallel, collapseNodes, commit, emptyDoc, exposeMacro, getDoc, placeLook, projectLooks, projectStore, saveLook, setParam, trialGraph, undo, updateMaster } from '../src/state/project';
import { uiStore } from '../src/state/ui';
import { applyRecipe, RECIPES } from '../src/state/recipes';

function setup() {
  endAudition();
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const src = getDoc().resources.sources[0].id;
  const a = addBlock(src, 0, 24, 'picture'), b = addBlock(src, 24, 48, 'picture');
  appendEffect(a, 'fx.chroma-drift'); appendEffect(a, 'fx.posterize');
  const effects = getDoc().timeline.blocks[0].graph.nodes.filter(n => n.kind.startsWith('fx.'));
  branchParallel(a, effects.map(n => n.id));
  const pick = getDoc().timeline.blocks[0].graph.nodes.filter(n => n.kind.startsWith('fx.') || n.kind === 'route.mix');
  const c = collapseNodes(a, pick.map(n => n.id), 'Branched look');
  const key = exposeMacro(a, c, effects[1].id, 'levels');
  setParam(a, c, key, 0.75);
  commit('Fixture: bypass and expression', d => {
    const inner = d.timeline.blocks[0].graph.nodes.find(n => n.id === c)!.body!.graph.nodes;
    inner.find(n => n.kind === 'fx.chroma-drift')!.bypass = true;
    inner.find(n => n.kind === 'fx.posterize')!.bindings.levels = { expression: { source: '0.5', op: 'replace' } };
  });
  const id = saveLook(a, c);
  return { a, b, c, key, id };
}
const target = () => getDoc().timeline.blocks[1];
// Compare render semantics without generated identities or editor geometry. Fixture kinds are unique.
function semantics(g: BlockGraph) {
  const flat = inlineContainers(g).graph;
  const kind = (id: string) => flat.nodes.find(n => n.id === id)!.kind;
  return {
    nodes: flat.nodes.map(n => ({ kind: n.kind, params: n.params, bindings: n.bindings, bypass: !!n.bypass })).sort((a,b) => a.kind.localeCompare(b.kind)),
    wires: flat.edges.map(e => `${kind(e.from.node)}:${e.from.port}>${kind(e.to.node)}:${e.to.port}`).sort(),
  };
}

describe('saved-look preview fidelity', () => {
  it('preserves branches, binding, bypass and turned macro values; preview equals placement without editing history', () => {
    const { b, id, key } = setup();
    const look = projectLooks(getDoc())[0];
    expect(look.params?.[key]).toBe(0.75);
    const before = projectStore.get();
    const preview = trialGraph(target(), [], undefined, look)!;
    expect(compileBlockGraph(b, preview).ok).toBe(true);
    expect(projectStore.get()).toBe(before);
    expect(trialGraph(target(), [], undefined, look)).toBe(preview);
    expect(preview.nodes.find(n => n.kind === 'group.container')!.params[key]).toBe(0.75);
    const sem = semantics(preview);
    expect(sem.wires.filter(w => w.includes('>route.mix:'))).toHaveLength(2);
    expect(sem.nodes.find(n => n.kind === 'fx.chroma-drift')!.bypass).toBe(true);
    expect(sem.nodes.find(n => n.kind === 'fx.posterize')!.bindings.levels.expression!.source).toBe('0.5');
    placeLook(b, id);
    expect(semantics(target().graph)).toEqual(sem);
    expect(projectStore.get().past.length).toBe(before.past.length + 1);
    undo(); expect(target().graph).toEqual(before.doc.timeline.blocks[1].graph);
  });

  it('moving inner nodes cannot alter preview signal order; changed masters invalidate the cached preview', () => {
    const { a, c, key } = setup();
    const original = projectLooks(getDoc())[0];
    const moved = structuredClone(original);
    moved.body.graph.nodes.forEach((n, i) => { n.position = { x: 1000 - i * 500, y: i * 123 }; });
    expect(semantics(trialGraph(target(), [], undefined, moved)!)).toEqual(semantics(trialGraph(target(), [], undefined, original)!));
    const recipe = (l: ComponentDef) => entries([], [l]).find(e => e.type === 'recipe' && e.recipe.lookId === l.id)!;
    expect(recipe(moved)).toEqual(recipe(original));
    const old = trialGraph(target(), [], undefined, original);
    setParam(a, c, key, 0.2); updateMaster(a, c);
    const next = projectLooks(getDoc())[0];
    expect(next.params?.[key]).toBe(0.2);
    expect(trialGraph(target(), [], undefined, next)).not.toBe(old);
    expect(semantics(trialGraph(target(), [], undefined, next)!)).not.toEqual(semantics(old!));
  });

  it('audition Apply places the same saved graph in one undo step, and missing looks never become fake chains', () => {
    const { b, id } = setup();
    const entry = entries(nodeDefs(), projectLooks(getDoc())).find(e => e.id === `look:${id}`)!;
    const a = auditionOf(entry, b)!;
    expect(a.recipe?.lookId).toBe(id);
    const preview = trialGraph(target(), a.kinds, a.params, projectLooks(getDoc())[0])!;
    const count = projectStore.get().past.length;
    applyAudition(a);
    expect(projectStore.get().past.length).toBe(count + 1);
    expect(semantics(target().graph)).toEqual(semantics(preview));
    expect(trialGraph(target(), a.kinds, a.params, null)).toBeNull();
  });

  it('audition Apply retains built-in recipe macros and values, and remains one undo step', () => {
    setup();
    const r = RECIPES.find(r => r.nm === 'Chroma Ghost')!;
    const e = entries([]).find(e => e.type === 'recipe' && e.recipe === r)!;
    const a = auditionOf(e, target().id)!;
    const preview = trialGraph(target(), a.kinds, a.params)!;
    const count = projectStore.get().past.length;
    applyAudition(a);
    expect(projectStore.get().past.length).toBe(count + 1);
    expect(target().graph.nodes.find(n => n.kind === 'group.container')!.body!.macros).toHaveLength(r.macros!.length);
    expect(semantics(target().graph)).toEqual(semantics(preview));
  });
  it('previews a stream-to-picture look through exactly one decode, as real placement does', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    addSource(demoProject().resources.sources[0]);
    const src = getDoc().resources.sources[0].id;
    const a = addBlock(src, 0, 24, 'picture'), b = addBlock(src, 24, 48, 'picture');
    applyRecipe(a, RECIPES.find(r => r.nm === 'VHS Decay')!);
    const box = getDoc().timeline.blocks[0].graph.nodes.find(n => n.kind === 'group.container')!;
    const id = saveLook(a, box.id);
    const preview = trialGraph(target(), [], undefined, projectLooks(getDoc())[0])!;
    expect(compileBlockGraph(b, preview).ok).toBe(true);
    expect(inlineContainers(preview).graph.nodes.filter(n => n.kind === 'decode.webcodecs')).toHaveLength(1);
    placeLook(b, id);
    expect(semantics(target().graph)).toEqual(semantics(preview));
  });

  it('repeated operator kinds get separate macro targets, preserving the intended recipe step', () => {
    setup();
    applyRecipe(target().id, {
      ic: '', nm: 'Two crunch stages', kinds: ['fx.posterize', 'fx.posterize'], params: [{ levels: 3 }, { levels: 12 }],
      src: 'test', look: 'Decay & Corrupt', does: 'Two independent steps',
      macros: [{ at: 0, param: 'levels', label: 'First', help: '' }, { at: 1, param: 'levels', label: 'Second', help: '' }],
    });
    const box = target().graph.nodes.find(n => n.kind === 'group.container')!;
    const body = box.body!;
    expect(body.macros.map(m => body.graph.nodes.find(n => n.id === m.target.node)!.params.levels)).toEqual([3, 12]);
    const first = body.macros[0].target.node, second = body.macros[1].target.node;
    setParam(target().id, box.id, body.macros[1].key, 1);
    const flat = inlineContainers(target().graph).graph;
    expect(flat.nodes.find(n => n.id === first)!.params.levels).toBe(3);
    expect(flat.nodes.find(n => n.id === second)!.params.levels).toBe(32);
  });

  it('staged saved-look knobs preview and apply exactly, clamp overrides, retain master and select the new container', () => {
    const { b, id, key } = setup();
    const look = projectLooks(getDoc())[0];
    const entry = entries([], [look]).find(e => e.type === 'recipe' && e.recipe.lookId === id)!;
    if (entry.type !== 'recipe') throw new Error('fixture');
    const staged = { ...entry, recipe: { ...entry.recipe, lookParams: { [key]: 999, unknown: 0.1 } } };
    const a = auditionOf(staged, b)!;
    const graph = trialGraph(target(), a.kinds, a.params, look, a.recipe!.lookParams)!;
    expect(trialGraph(target(), a.kinds, a.params, look, a.recipe!.lookParams)).toBe(graph);
    expect(graph.nodes.find(n => n.kind === 'group.container')!.params).toEqual({ [key]: 1 });
    expect(projectLooks(getDoc())[0]).toBe(look);
    const steps = projectStore.get().past.length;
    expect(applyAudition(a)).toBe(true);
    const placed = target().graph.nodes.find(n => n.kind === 'group.container')!;
    expect(getDoc().view.perBlock[b].selected).toEqual([placed.id]);
    expect(projectStore.get().past.length).toBe(steps + 1);
    expect(semantics(target().graph)).toEqual(semantics(graph));
    expect(projectLooks(getDoc())[0].params?.[key]).toBe(0.75);
    expect(applyAudition({ ...a, blockId: 'gone' })).toBe(false);
  });

  it('stages the full built-in look once and installs identical graph/node identities, not a new random realization', () => {
    setup();
    const entry = entries([]).find(e => e.id === 'recipe:VHS Decay')!;
    const raw = auditionOf(entry, target().id)!;
    const before = projectStore.get();
    const staged = startAudition(raw)!;
    const graph = auditionGraph(staged)!;
    expect(graph.nodes.find(n => n.kind === 'group.container')!.body!.macros).toHaveLength(4);
    expect(prepareAudition({ ...raw })).toBe(staged);
    expect(startAudition({ ...raw })).toBe(staged);
    expect(auditionGraph(staged)).toBe(graph);
    expect(projectStore.get()).toBe(before);
    const flat = inlineContainers(graph).graph;
    expect(applyAudition(staged)).toBe(true);
    expect(target().graph).toBe(graph);
    expect(inlineContainers(target().graph).graph.nodes.map(n => n.id)).toEqual(flat.nodes.map(n => n.id));
    expect(projectStore.get().past.length).toBe(before.past.length + 1);
    undo(); expect(target().graph).toBe(before.doc.timeline.blocks[1].graph);
  });

  it('stages saved look bindings and macro values as one immutable graph; Apply keeps its exact IDs', () => {
    const { id, b, key } = setup();
    const e = entries([], projectLooks(getDoc())).find(e => e.id === `look:${id}`)!;
    const raw = auditionOf(e, b)!;
    raw.recipe = { ...raw.recipe!, lookParams: { [key]: 0.4 } };
    const a = prepareAudition(raw)!;
    const graph = auditionGraph(a)!;
    expect(Object.isFrozen(graph)).toBe(true);
    const box = graph.nodes.find(n => n.kind === 'group.container')!;
    expect(box.params[key]).toBe(0.4);
    expect(box.body!.graph.nodes.find(n => n.kind === 'fx.posterize')!.bindings.levels.expression!.source).toBe('0.5');
    expect(applyAudition(a)).toBe(true);
    expect(target().graph).toBe(graph);
  });

  it('an intervening graph edit cancels the preview; stale Apply cannot overwrite it or add an undo step', () => {
    setup();
    const e = entries(nodeDefs()).find(e => e.id === 'fx.salt-pepper') ?? entries(nodeDefs()).find(e => e.type === 'node' && e.side === 'picture')!;
    const a = startAudition(auditionOf(e, target().id)!)!;
    expect(a.candidate).toBeDefined();
    appendEffect(target().id, 'fx.invert');
    const edited = projectStore.get();
    expect(uiStore.get().audition).toBeUndefined();
    expect(auditionGraph(a)).toBeNull();
    expect(applyAudition(a)).toBe(false);
    expect(projectStore.get()).toBe(edited);
    expect(startAudition(a)).toBeNull();
  });

  it('changing the saved master invalidates an old candidate instead of replacing it at Apply', () => {
    const { id, a, c, key, b } = setup();
    const e = entries([], projectLooks(getDoc())).find(e => e.id === `look:${id}`)!;
    const staged = startAudition(auditionOf(e, b)!)!;
    setParam(a, c, key, 0.1); updateMaster(a, c);
    const edited = projectStore.get();
    expect(auditionGraph(staged)).toBeNull();
    expect(applyAudition(staged)).toBe(false);
    expect(projectStore.get()).toBe(edited);
  });

  it('all ordered built-in look pairs produce compilable complete candidates', () => {
    const recipes = RECIPES.filter(r => r.kinds.length);
    for (const first of recipes) for (const second of recipes) {
      endAudition();
      projectStore.set({ doc: emptyDoc(), past: [], future: [] });
      addSource(demoProject().resources.sources[0]);
      const blockId = addBlock(getDoc().resources.sources[0].id, 0, 48, 'picture');
      applyRecipe(blockId, first);
      const a = prepareAudition({ id: `recipe:${second.nm}`, label: second.nm, blockId, kinds: second.kinds, params: second.params, recipe: second });
      expect(a, `${first.nm} + ${second.nm}`).not.toBeNull();
      expect(compileBlockGraph(blockId, a!.candidate!.graph).ok).toBe(true);
    }
  });

});
