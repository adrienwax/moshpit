// What a control client may address right now (CONTROL-PROTOCOL.md "discover"): the active
// block's nodes as slots, their params as targets with a ParamSpec, the project LFOs, and the
// command list. Derived from the project and the node registry only: no CT-specific code (R6).

import { COMMANDS, targetPath, type BlockId, type Lfo, type NodeInstance, type ParamDef, type ParamKey, type ProjectDoc } from '@moshpit/core';
import { DECODE, DEF_BY_KIND, SOURCE_CLIP, OUTPUT } from '../nodes/defs';
import { compileBlockGraph } from '../graph/stage2';
import { CONTAINER_KIND, macroParams, macroValue } from '../graph/container';

/** The reserved key: every node's bypass, exposed as a bool target. No definition may use it. */
export const BYPASS_KEY = 'bypass';

export interface ParamSpec {
  key: string;
  label: string;
  type: ParamDef['type'];
  default: number | boolean | string;
  /** Reset/new-node value; omitted old-project keys still use the neutral default. */
  initial?: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  unit?: string;
  help: string;
}

export interface Target { path: string; generation: number; param: ParamSpec; value: number | boolean | string; modulated: boolean }
export interface Slot { nodeId: string; name: string; index: number; params: string[] }
/** Moshpit's inspector selection in the active block (M1). `slot` is null for a node with no slot (Source, Output). */
export interface Selection { nodeId: string; slot: number | null }
export interface Discovery { generation: number; activeBlock: string | null; targets: Target[]; slots: Slot[]; commands: readonly string[]; selected: Selection | null }

const BYPASS_SPEC: ParamSpec = { key: BYPASS_KEY, label: 'Bypass', type: 'bool', default: false, help: 'Pass the input through untouched. The node keeps its settings.' };

const spec = (d: ParamDef): ParamSpec => ({ key: d.key, label: d.label, type: d.type, default: d.default, initial: d.initial, min: d.min, max: d.max, step: d.step ?? (d.min !== undefined && d.max !== undefined && d.type === 'float' ? (d.max - d.min) / 200 : d.type === 'int' ? 1 : undefined), options: d.options, unit: d.unit, help: d.help });

/** Params in CT dial order: ctOrder first (S10), then the rest in definition order. */
export function dialOrder(params: readonly ParamDef[]): ParamDef[] {
  return [...params].sort((a, b) => (a.ctOrder ?? 99) - (b.ctOrder ?? 99));
}

export function lfoSpecs(l: Lfo): [ParamSpec, ParamSpec] {
  return [
    { key: 'period', label: `${l.label} rate`, type: 'float', default: l.period, min: 0.25, max: 64, step: 0.25, unit: l.unit === 'beats' ? 'beats' : 's', help: 'Length of one cycle.' },
    { key: 'phase', label: `${l.label} phase`, type: 'float', default: l.phase, min: 0, max: 1, step: 0.01, help: 'Where in the cycle the timeline starts.' },
  ];
}

export function discover(doc: ProjectDoc, generation: number, activeBlock: BlockId | null = doc.view.activeBlock ?? doc.timeline.blocks[0]?.id ?? null): Discovery {
  const targets: Target[] = [], slots: Slot[] = [];
  const block = doc.timeline.blocks.find((b) => b.id === activeBlock);
  if (block) {
    const plan = compileBlockGraph(block.id, block.graph);
    const byId = new Map(block.graph.nodes.map((n) => [n.id as string, n]));
    // 3.3 (A10): a container is one slot, its dials its macros; its inner nodes are not slots of their own.
    for (const c of block.graph.nodes) if (c.kind === CONTAINER_KIND) for (const n of c.body?.graph.nodes ?? []) byId.set(n.id, c);
    // Chain order: the encoded prefix after the source, then the GPU steps; never the source or the output.
    const order = [...plan.encodedChain.slice(1), ...plan.steps.map((s) => s.node), ...plan.commits.map((c) => c.node)]
      .map((id) => byId.get(id)).filter((n, i, a): n is NodeInstance => !!n && n.kind !== 'output.sink' && a.indexOf(n) === i);
    // Discovery describes editable controls, not just pixels currently reaching Output. Keep live
    // slot positions first, then append disconnected nodes in document order so graph audition and
    // rewiring do not make a selected effect's controls disappear. Container internals stay private:
    // a Look remains one slot with its explicitly exposed macros.
    const boundaries = new Set<string>([SOURCE_CLIP.kind, DECODE.kind, OUTPUT.kind, 'group.in', 'group.out']);
    for (const n of block.graph.nodes) if (!boundaries.has(n.kind) && !order.includes(n)) order.push(n);
    order.forEach((n, i) => {
      const box = n.kind === CONTAINER_KIND;
      const def = DEF_BY_KIND.get(n.kind);
      const params: string[] = [];
      for (const d of dialOrder(box ? macroParams(n) : def?.params ?? [])) {
        const path = targetPath({ scope: 'node', blockId: block.id, nodeId: n.id, param: d.key });
        const v = box ? macroValue(n, d.key) : n.params[d.key];
        targets.push({ path, generation, param: spec(d), value: typeof v === 'object' || v === undefined ? d.default : v, modulated: !!(n.bindings?.[d.key]?.lfo || n.bindings?.[d.key]?.expression) });
        params.push(path);
      }
      // Bypass on every slot, a look's included (A/B the whole look in place).
      const bp = targetPath({ scope: 'node', blockId: block.id, nodeId: n.id, param: BYPASS_KEY as ParamKey });
      targets.push({ path: bp, generation, param: BYPASS_SPEC, value: !!n.bypass, modulated: false });
      params.push(bp);
      slots.push({ nodeId: n.id, name: n.label ?? def?.label ?? n.kind, index: i + 1, params });
    });
  }
  // LFOs after node targets, in project order (LFO 1, 2, 3 …), period before phase.
  for (const l of doc.modulators.lfos) {
    const [p, ph] = lfoSpecs(l);
    targets.push({ path: targetPath({ scope: 'lfo', lfoId: l.id, field: 'period' }), generation, param: p, value: l.period, modulated: false });
    targets.push({ path: targetPath({ scope: 'lfo', lfoId: l.id, field: 'phase' }), generation, param: ph, value: l.phase, modulated: false });
  }
  return { generation, activeBlock: block?.id ?? null, targets, slots, commands: COMMANDS, selected: selectionOf(doc, slots, block?.id ?? null) };
}

/** The first selected node of the active block, as the inspector shows it (M1: one selection for UI and CT). */
export function selectionOf(doc: ProjectDoc, slots: Slot[], activeBlock: string | null): Selection | null {
  const nodeId = activeBlock ? doc.view.perBlock?.[activeBlock as BlockId]?.selected?.[0] : undefined;
  if (!nodeId) return null;
  return { nodeId, slot: slots.find((s) => s.nodeId === nodeId)?.index ?? null };
}

/**
 * All address/order/spec dependencies, including discovery labels. Knob positions and canvas
 * geometry are excluded: ordinary detents do not invalidate queued input. A rename, wire edit or
 * macro definition change does trigger rediscovery. Both sides use the same generation contract.
 */
export function discoveryShape(doc: ProjectDoc): string {
  return JSON.stringify([
    doc.id,
    doc.view.activeBlock,
    doc.timeline.blocks.map((b) => [b.id,
      b.graph.nodes.map((n) => [n.id, n.kind, n.label, n.kind === CONTAINER_KIND ? [n.body?.ports, n.body?.macros, macroParams(n), n.body?.graph.nodes.map((inner) => [inner.id, inner.kind]), n.body?.graph.edges] : null]),
      b.graph.edges.map((e) => [e.from, e.to]),
    ]),
    doc.modulators.lfos.map((l) => [l.id, l.label, l.unit]),
  ]);
}

/** The ParamDef a write resolves against, for node params, bypass and LFO fields alike. */
export function defForTarget(doc: ProjectDoc, path: string, generation: number): { def: ParamDef; value: number | boolean | string; label: string } | null {
  const t = discover(doc, generation, (/^\/block\/([^/]+)/.exec(path)?.[1] as BlockId) ?? null).targets.find((x) => x.path === path);
  if (!t) return null;
  const p = t.param;
  return { def: { key: p.key as ParamKey, label: p.label, help: p.help, type: p.type, default: p.default, initial: p.initial, min: p.min, max: p.max, step: p.step, options: p.options, unit: p.unit }, value: t.value, label: p.label };
}

/** Diff effective base values, including overrides removed by undo/reset and macro defaults. */
export function changedControlValues(previous: ProjectDoc, next: ProjectDoc, generation: number): Target[] {
  const before = new Map(discover(previous, generation).targets.map(target => [target.path, target.value]));
  return discover(next, generation).targets.filter(target => !before.has(target.path) || before.get(target.path) !== target.value);
}
