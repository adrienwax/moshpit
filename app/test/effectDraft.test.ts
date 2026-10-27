import { describe, expect, it } from 'vitest';
import { PRESETS, inlineContainers } from '@moshpit/engine';
import { nodeDefs } from '../src/engine';
import { demoProject } from '../src/engine/mockProject';
import { entries } from '../src/lib/browse';
import { auditionDraft, changeDraft, draftTargetIssue, draftValue, makeEffectDraft, presetDraft, restoreDraft } from '../src/lib/effectDraft';
import { applyAudition } from '../src/components/AuditionBar';
import { addBlock, addSource, appendEffect, collapseNodes, emptyDoc, exposeMacro, getDoc, projectLooks, projectStore, saveLook, setParam, undo } from '../src/state/project';

function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const src = getDoc().resources.sources[0].id;
  return addBlock(src, 0, 48, 'picture');
}
const entry = (id: string) => entries(nodeDefs(), projectLooks(getDoc())).find(e => e.id === id)!;

describe('staged effect controls', () => {
  it('tunes an operator without editing the document; Apply uses exact values and one Undo restores it', () => {
    const id = setup(), before = projectStore.get();
    const draft = makeEffectDraft(entry('fx.posterize'), id);
    const key = draft.controls.find(c => c.key === 'levels')!.id;
    const tuned = changeDraft(draft, key, 7);
    expect(draft.params[0]?.levels).not.toBe(7);
    expect(projectStore.get()).toBe(before);
    expect(applyAudition(auditionDraft(tuned)!)).toBe(true);
    expect(getDoc().timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.posterize')!.params.levels).toBe(7);
    expect(projectStore.get().past.length).toBe(before.past.length + 1);
    undo(); expect(getDoc().timeline.blocks[0].graph).toEqual(before.doc.timeline.blocks[0].graph);
  });

  it('uses the existing legacy preset values, resetting unspecified params to starting values', () => {
    const id = setup(), draft = makeEffectDraft(entry('fx.posterize'), id);
    const preset = PRESETS['fx.posterize'][0];
    const next = presetDraft(draft, preset.name);
    expect(next.preset).toBe(preset.name);
    for (const [key, v] of Object.entries(preset.params)) expect(next.params[0]?.[key]).toEqual(v);
    expect(auditionDraft(next)?.params).toBe(next.params);
    expect(presetDraft(next, 'missing')).toBe(next);
  });

  it('built-in recipe controls use authored labels/ranges and feed Apply as the same recipe', () => {
    const id = setup(), original = entry('recipe:VHS Decay');
    const draft = makeEffectDraft(original, id);
    const bleed = draft.controls.find(c => c.spec.label === 'Bleed red')!;
    expect(bleed.spec.min).toBe(-128); expect(bleed.spec.max).toBe(0);
    const tuned = changeDraft(draft, bleed.id, -64);
    expect(tuned.recipe?.params).toBe(tuned.params);
    expect(auditionDraft(tuned)?.recipe).toBe(tuned.recipe);
    expect(applyAudition(auditionDraft(tuned)!)).toBe(true);
    const flat = inlineContainers(getDoc().timeline.blocks[0].graph).graph;
    expect(flat.nodes.find(n => n.kind === 'fx.chroma-drift')!.params.cr).toBe(-64);
    expect(original.type === 'recipe' && original.recipe.params?.[1]?.cr).not.toBe(-64);
  });

  it('saved looks expose and tune macro instance values without changing the master', () => {
    const id = setup(); appendEffect(id, 'fx.posterize');
    const node = getDoc().timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.posterize')!;
    const box = collapseNodes(id, [node.id], 'My look');
    const key = exposeMacro(id, box, node.id, 'levels');
    setParam(id, box, key, 0.6);
    const lookId = saveLook(id, box), master = projectLooks(getDoc())[0];
    const draft = makeEffectDraft(entry(`look:${lookId}`), id, master);
    expect(draftValue(draft, draft.controls[0])).toBe(0.6);
    const tuned = changeDraft(draft, draft.controls[0].id, 0.25);
    expect(tuned.recipe?.lookParams?.[key]).toBe(0.25);
    expect(master.params?.[key]).toBe(0.6);
    const count = projectStore.get().past.length;
    expect(applyAudition(auditionDraft(tuned)!)).toBe(true);
    const copies = getDoc().timeline.blocks[0].graph.nodes.filter(n => n.kind === 'group.container');
    expect(copies[copies.length - 1].params[key]).toBe(0.25);
    expect(projectStore.get().past.length).toBe(count + 1);
    expect(projectLooks(getDoc())[0]).toBe(master);
  });

  it('rejects non-finite/type-invalid edits, clamps integer values, and keeps reset as a fresh starting point', () => {
    const id = setup(), e = entry('fx.posterize'), draft = makeEffectDraft(e, id);
    const c = draft.controls.find(c => c.key === 'levels')!;
    expect(changeDraft(draft, c.id, NaN)).toBe(draft);
    expect(changeDraft(draft, c.id, Infinity)).toBe(draft);
    expect(changeDraft(draft, c.id, 'invalid')).toBe(draft);
    expect(draftValue(changeDraft(draft, c.id, 99999), c)).toBe(c.spec.max);
    expect(draftValue(changeDraft(draft, c.id, 5.8), c)).toBe(6);
    expect(makeEffectDraft(e, id).params).toEqual(draft.params);
  });

  it('utilities and block-kind actions do not manufacture previews', () => {
    const id = setup();
    expect(auditionDraft(makeEffectDraft(entry('route.mix'), id))).toBeNull();
    expect(auditionDraft(makeEffectDraft(entry('recipe:I-frame Bloom'), id))).toBeNull();
  });

  it('invalidates switched, deleted and frozen targets without quietly retargeting', () => {
    const id = setup(), d = makeEffectDraft(entry('fx.posterize'), id);
    expect(draftTargetIssue(d, id, true, false)).toBeNull();
    expect(draftTargetIssue(d, 'other', true, false)).toContain('selected block changed');
    expect(draftTargetIssue(d, undefined, false, false)).toContain('removed');
    expect(draftTargetIssue(d, id, true, true)).toContain('frozen');
  });

  it('restores a shortlisted tuned candidate without sharing mutable parameter objects or retargeting it', () => {
    const id = setup(), d = makeEffectDraft(entry('fx.posterize'), id);
    const c = d.controls.find(c => c.key === 'levels')!;
    const a = auditionDraft(changeDraft(d, c.id, 9))!;
    const restored = restoreDraft(d, a);
    expect(draftValue(restored, c)).toBe(9);
    expect(restored.params).not.toBe(a.params);
    expect(restoreDraft(d, { ...a, blockId: 'other' })).toBe(d);
    expect(restoreDraft(d, { ...a, id: 'other' })).toBe(d);
  });
});
