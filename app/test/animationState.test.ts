import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject } from '../../engine/src/project/io';
import { changeEnvelope, envelopeParams, focusAnimation } from '../src/state/animation';
import { readEnvelope, type Envelope } from '../src/lib/parameterEnvelope';
import { demoProject } from '../src/engine/mockProject';
import { addBlock, addSource, appendEffect, beginGesture, commit, emptyDoc, endGesture, getDoc, moveBlock, nodesOf, projectStore, setBlock, undo, redo } from '../src/state/project';

import { uiStore, setUi } from '../src/state/ui';
import { readSticky, writeSticky } from '../src/state/store';

const curve: Envelope = { version: 1, start: 1, end: 3, from: 0, to: 90, ease: 'smooth', hue: 'direct' };
function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const block = addBlock(getDoc().resources.sources[0].id, 0, 240, 'picture');
  appendEffect(block, 'fx.hue-rotate');
  const node = getDoc().timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.hue-rotate')!.id;
  return { block, node };
}
const current = () => nodesOf(getDoc().timeline.blocks[0]).find(n => n.kind === 'fx.hue-rotate')!;

describe('timeline envelope commands', () => {
  it('uses one undo per drag, preserves the manual value, and restores through redo', () => {
    const { block, node } = setup(), base = current().params.degrees;
    changeEnvelope(block, node, 'degrees', curve, true);
    const n = projectStore.get().past.length;
    beginGesture();
    changeEnvelope(block, node, 'degrees', { ...curve, to: 60 });
    changeEnvelope(block, node, 'degrees', { ...curve, to: 80 });
    endGesture();
    expect(projectStore.get().past).toHaveLength(n + 1);
    expect(current().params.degrees).toEqual(base);
    undo(); expect(readEnvelope(current().bindings.degrees)?.to).toBe(90);
    redo(); expect(readEnvelope(current().bindings.degrees)?.to).toBe(80);
  });
  it('restores an existing formula and opaque binding fields exactly after a project roundtrip', () => {
    const { block, node } = setup();
    const binding = { expression: { source: '90*sin(time)', op: 'add' as const, provenance: { custom: true } },
      lfo: { lfoId: 'missing-lfo' as never, depth: .3, op: 'add' as const }, opaque: ['keep'] };
    commit('seed formula', d => { nodesOf(d.timeline.blocks[0]).find(n => n.id === node)!.bindings.degrees = binding; });
    changeEnvelope(block, node, 'degrees', curve, true);
    const loaded = parseProject(serializeProject(getDoc())).doc;
    projectStore.set({ doc: loaded, past: [], future: [] });
    changeEnvelope(block, node, 'degrees', null);
    expect(current().bindings.degrees).toEqual(binding);
  });
  it('does not overwrite a formula edited outside the envelope editor', () => {
    const { block, node } = setup();
    changeEnvelope(block, node, 'degrees', curve, true);
    commit('custom formula', d => { nodesOf(d.timeline.blocks[0]).find(n => n.id === node)!.bindings.degrees.expression!.source = '42'; });
    const before = getDoc();
    expect(() => changeEnvelope(block, node, 'degrees', curve)).toThrow('formula changed');
    expect(() => changeEnvelope(block, node, 'degrees', null)).toThrow('formula changed');
    expect(getDoc()).toBe(before);
  });
  it('keeps timeline-time curves unchanged when a block moves or repeats', () => {
    const { block, node } = setup();
    changeEnvelope(block, node, 'degrees', curve, true);
    const binding = current().bindings.degrees;
    addBlock(getDoc().resources.sources[0].id, 0, 60, 'picture');
    moveBlock(0, 1); setBlock(block, { repeat: 2 });
    expect(nodesOf(getDoc().timeline.blocks[1]).find(n => n.id === node)!.bindings.degrees).toEqual(binding);
  });
  it('rejects stale targets, unsupported parameters, non-hue wrapping and out-of-range endpoints without history edits', () => {
    const { block, node } = setup(), before = projectStore.get();
    expect(envelopeParams(current()).map(p => p.key)).toEqual(['degrees', 'wet']);
    for (const action of [
      () => changeEnvelope(block, 'gone' as never, 'degrees', curve, true),
      () => changeEnvelope(block, node, 'not-a-param', curve, true),
      () => changeEnvelope(block, node, 'degrees', { ...curve, to: 181 }, true),
      () => changeEnvelope(block, node, 'wet', { ...curve, to: 1, hue: 'shortest' }, true),
    ]) expect(action).toThrow();
    expect(projectStore.get()).toBe(before);
  });
});

it('explicit Animate reveals Processing from Source range without changing clocks, ownership or bindings', () => {
  const { block, node } = setup();
  writeSticky('desk.detail', 'source');writeSticky('program.left', 'B');
  setUi({ ws: 'mosh', playhead: 17, playing: false, loupes: { A: { frame: 23 }, B: { frame: 56 } } });
  const before = uiStore.get(), binding = structuredClone(current().bindings);
  focusAnimation(block, node, 'degrees');
  expect(readSticky('desk.detail')).toBe('processing');expect(readSticky('program.left')).toBe('B');
  expect(uiStore.get().playhead).toBe(17);expect(uiStore.get().playing).toBe(false);expect(uiStore.get().loupes).toBe(before.loupes);
  expect(uiStore.get().animation).toEqual({ blockId: block, nodeId: node, key: 'degrees' });expect(current().bindings).toEqual(binding);
});
