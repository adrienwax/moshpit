import type { BlockId, NodeId, NodeInstance, ParamDef, ParamBinding } from '@moshpit/engine';
import { defOf } from '../engine';
import { commit, getDoc, isFrozen, nodesOf, selectNode } from './project';
import { setUi } from './ui';
import { openDeskDetail } from './desk';
import { DEFAULT_LAYOUTS, layoutStore, setWsLayout } from '../layout/model';
import { enableEnvelope, readEnvelope, removeEnvelope, updateEnvelope, type Envelope } from '../lib/parameterEnvelope';

/** First timeline authoring slice: continuous hue and image-effect mix only. */
export function envelopeParams(node: NodeInstance): ParamDef[] {
  const def = defOf(node.kind);
  if (!def || def.defVersion > node.defVersion || node.body) return [];
  return def.params.filter(p => p.modulatable && p.type === 'float' &&
    ((node.kind === 'fx.hue-rotate' && p.key === 'degrees') || p.key === 'wet'));
}

export function focusAnimation(blockId: BlockId, nodeId: NodeId, key: string) {
  selectNode(blockId, nodeId);
  setUi({ ws: 'mosh', fxPanel: false, animation: { blockId, nodeId, key } });
  const stored = layoutStore.get().current.mosh ?? DEFAULT_LAYOUTS.mosh;
  const known = [...new Set([...DEFAULT_LAYOUTS.mosh, ...stored].flatMap(c => c.stacks.flatMap(s => s.panes)))];
  setWsLayout('mosh', cols => cols.map(c => ({ ...c, ...(c.band && c.stacks.some(s => s.panes.includes('edit')) ? { h: Math.max(c.h ?? 0, .6) } : {}), stacks: c.stacks.map(s => s.panes.includes('edit')
    ? { ...s, active: s.panes.indexOf('edit'), collapsed: false } : s) })), known);
  openDeskDetail('processing');
}

export function changeEnvelope(blockId: BlockId, nodeId: NodeId, key: string, value: Envelope | null, activate = false) {
  const doc = getDoc(), block = doc.timeline.blocks.find(b => b.id === blockId);
  const node = block && nodesOf(block).find(n => n.id === nodeId);
  const param = node && envelopeParams(node).find(p => p.key === key);
  if (!node || !param) throw new Error('This parameter is not available for timeline easing.');
  if (isFrozen(doc, { kind: 'block', blockId })) throw new Error('Unfreeze this block before editing its animation.');
  const old = node.bindings[key];
  if (!activate && !readEnvelope(old)) throw new Error('The formula changed. Its custom expression has been kept.');
  if (value && (value.from < (param.min ?? 0) || value.from > (param.max ?? 1) ||
    value.to < (param.min ?? 0) || value.to > (param.max ?? 1) ||
    (value.hue === 'shortest' && !(node.kind === 'fx.hue-rotate' && key === 'degrees')))) {
    throw new Error('Animation values must be inside the parameter range.');
  }
  const next = value ? activate ? enableEnvelope(old, value) : updateEnvelope(old, value) : removeEnvelope(old);
  if (next === old) return;
  commit(value ? 'Edited timeline easing' : 'Restored previous parameter source', d => {
    const b = d.timeline.blocks.find(b => b.id === blockId)!;
    const n = nodesOf(b).find(n => n.id === nodeId)!;
    if (next) n.bindings[key] = next as ParamBinding;
    else delete n.bindings[key];
  });
}
