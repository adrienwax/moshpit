// §1f STAGE 2 — the per-block graph compiler. One block's node graph → an execution plan.
//
// It splits the graph at the one decode boundary: the encoded-domain prefix (source → in-block
// mosh ops) is handed to stage 1 as EncodedOps; everything after decode becomes an ordered list
// of GPU steps over pre-allocated texture slots, so the runtime loop allocates nothing (L21).
//
// Rules enforced here, each with a stable error code (L26): typed ports (L1/L3), cardinality and
// one wire per input (L5), cycles only through Delay (L10), encoded nodes only before the decode
// boundary (§1f/B1), an Output to terminate. Unknown and legacy nodes compile as pass-through
// with a warning, never as a crash (D6/C4).

import { elideDecode } from './decode';
import { inlineContainers } from './container';
import { historyFrames } from '../nodes/ops/temporal';
import { MoshpitError } from '../errors';
import type { BlockGraph, NodeInstance, GraphEdge } from '@moshpit/core';
import type { DisconnectedSemantics, ImplState, NodeDef } from '@moshpit/core';
import type { BlockId, NodeId } from '@moshpit/core';
import type { EncodedOp } from '../timeline/stage1';
import { DEF_BY_KIND, DELAY, OUTPUT } from '../nodes/defs';
import { canWire } from './wiring';
import { TRANSFORMS } from '../nodes/ops/bitstream';
import { numericBase } from '../control/params';

export type NodeStatus = ImplState | 'LEGACY' | 'UNKNOWN' | 'BYPASSED';

export interface Step {
  node: NodeId;
  def: NodeDef;
  /** Slot per declared input port, in definition order. -1 = disconnected. */
  inputs: number[];
  disconnected: (DisconnectedSemantics | null)[];
  /** Field<Mask> fed from a VideoFrame: read its luma (an inserted conversion, L1). */
  lumaInputs: boolean[];
  output: number;
  /** Runs as a copy of its first input: unknown kind, legacy version, or bypassed (D6). */
  passThrough: boolean;
}

export interface BlockPlan {
  blockId: BlockId;
  /** Hard errors block execution; warnings ride along with a working plan. */
  errors: MoshpitError[];
  warnings: MoshpitError[];
  ok: boolean;
  /** Encoded prefix, in order from the source (stage 1 runs these). */
  encodedChain: NodeId[];
  encodedOps: EncodedOp[];
  /** Slot holding the decoded frame of the block's primary stream. */
  decodeSlot: number;
  steps: Step[];
  /** Delay nodes: after every step has run, copy `from` slot into the node's state (commit, L9). */
  commits: { node: NodeId; from: number }[];
  /** Persistent slot per Delay node: holds input(n−1) at the start of frame n. */
  delaySlots: Map<NodeId, number>;
  terminal: NodeId | null;
  outputSlot: number;
  /** Transient + delay slots the runtime pre-allocates. */
  slotCount: number;
  stateful: NodeId[];
  pastDependent: boolean;
  status: Map<NodeId, NodeStatus>;
  /** Working-frame-sized textures this plan holds while live (slots + node working + state). */
  workingFrames: number;
}

export interface CompileOptions {
  /** §1e per-node viewer: evaluate up to this node instead of the Output. */
  terminal?: NodeId;
  /** L18: which backend the status map describes. */
  backend?: 'preview' | 'export';
}

const encodedDomain = (d: NodeDef) => d.domain === 'ENCODED_STREAM';

export function compileBlockGraph(blockId: BlockId, drawn: BlockGraph, opts: CompileOptions = {}): BlockPlan {
  // 3.2 Phase 3: containers inline first (graph/container.ts), then Phase 1.1: Decode nodes are the
  // drawn boundary only; compile the graph without them. Both aliases follow a viewer through.
  const inlined = inlineContainers(drawn);
  const { graph: g, alias } = elideDecode(inlined.graph);
  if (opts.terminal && inlined.alias.has(opts.terminal)) opts = { ...opts, terminal: inlined.alias.get(opts.terminal) };
  if (opts.terminal && alias.has(opts.terminal)) opts = { ...opts, terminal: alias.get(opts.terminal) };
  const errors: MoshpitError[] = [...inlined.errors], warnings: MoshpitError[] = [];
  const err = (e: MoshpitError) => errors.push(e);
  const byId = new Map<NodeId, NodeInstance>(g.nodes.map((n) => [n.id, n]));
  const defOf = new Map<NodeId, NodeDef | null>();
  const status = new Map<NodeId, NodeStatus>();
  const backend = opts.backend ?? 'export';

  for (const n of g.nodes) {
    const def = DEF_BY_KIND.get(n.kind) ?? null;
    defOf.set(n.id, def);
    if (!def) { status.set(n.id, 'UNKNOWN'); warnings.push(new MoshpitError('NODE_UNKNOWN_KIND', { blockId, nodeId: n.id, kind: n.kind })); continue; }
    if (n.defVersion < def.defVersion) { status.set(n.id, 'LEGACY'); warnings.push(new MoshpitError('NODE_LEGACY', { blockId, nodeId: n.id, kind: n.kind, from: n.defVersion, to: def.defVersion })); continue; }
    if (n.bypass) { status.set(n.id, 'BYPASSED'); continue; }
    status.set(n.id, backend === 'preview' ? def.impl.preview : def.impl.export);
    if (n.carryState && def.temporal.boundary === 'carry-optional') warnings.push(new MoshpitError('NODE_CARRY_STATE_UNAVAILABLE', { blockId, nodeId: n.id }));
  }

  // Wiring: types, cardinality, occupancy.
  const incoming = new Map<string, GraphEdge[]>(); // `${node}:${port}`
  const outgoing = new Map<NodeId, GraphEdge[]>();
  const inEdges = new Map<NodeId, GraphEdge[]>(); // every valid edge by its target: no per-node scan of g.edges
  for (const e of g.edges) {
    const from = byId.get(e.from.node), to = byId.get(e.to.node);
    if (!from || !to) { err(new MoshpitError('GRAPH_TYPE_MISMATCH', { blockId, edgeId: e.id, why: 'dangling edge' })); continue; }
    const fd = defOf.get(from.id), td = defOf.get(to.id);
    const op = fd?.outputs.find((p) => p.key === e.from.port), ip = td?.inputs.find((p) => p.key === e.to.port);
    if (fd && !op) { err(new MoshpitError('GRAPH_TYPE_MISMATCH', { blockId, edgeId: e.id, why: `no output ${e.from.port}` })); continue; }
    if (td && !ip) { err(new MoshpitError('GRAPH_TYPE_MISMATCH', { blockId, edgeId: e.id, why: `no input ${e.to.port}` })); continue; }
    if (op && ip && !compatible(op.type, ip.type)) err(new MoshpitError('GRAPH_TYPE_MISMATCH', { blockId, edgeId: e.id, from: op.type, to: ip.type }));
    const k = `${to.id}:${e.to.port}`;
    const list = incoming.get(k) ?? [];
    list.push(e);
    incoming.set(k, list);
    if (ip && ip.cardinality !== 'many' && list.length > 1) err(new MoshpitError('GRAPH_PORT_OCCUPIED', { blockId, nodeId: to.id, port: e.to.port }));
    (outgoing.get(from.id) ?? outgoing.set(from.id, []).get(from.id)!).push(e);
    (inEdges.get(to.id) ?? inEdges.set(to.id, []).get(to.id)!).push(e);
  }
  const wiresInto = (n: NodeId, p: string) => {
    const list = incoming.get(`${n}:${p}`) ?? [];
    const order = byId.get(n)?.inputOrder?.[p];
    return order ? [...list].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) : list;
  };
  const isDelay = (n: NodeId) => byId.get(n)?.kind === DELAY.kind && status.get(n) !== 'UNKNOWN';

  // Terminal: the Output (or the viewed node).
  const outputs = g.nodes.filter((n) => n.kind === OUTPUT.kind);
  const terminal = opts.terminal ?? outputs[0]?.id ?? null;
  if (!terminal) err(new MoshpitError('GRAPH_NO_OUTPUT', { blockId }));

  // Live set: ancestors of the terminal, plus whatever every live Delay's input needs (its state must be committed).
  const live = new Set<NodeId>();
  const visit = (n: NodeId) => {
    if (live.has(n)) return;
    live.add(n);
    for (const e of inEdges.get(n) ?? []) visit(e.from.node);
  };
  if (terminal) visit(terminal);

  // Cycles: any strongly connected component must contain a Delay (L10).
  for (const scc of tarjan(g.nodes.map((n) => n.id), (n) => (outgoing.get(n) ?? []).map((e) => e.to.node))) {
    const cyclic = scc.length > 1 || (outgoing.get(scc[0]) ?? []).some((e) => e.to.node === scc[0]);
    if (cyclic && !scc.some(isDelay)) err(new MoshpitError('GRAPH_CYCLE', { blockId, nodes: scc }));
  }

  // Domain split: the encoded prefix is a chain from the source; nothing encoded after decode.
  const encodedChain: NodeId[] = [], encodedOps: EncodedOp[] = [];
  const sources = g.nodes.filter((n) => defOf.get(n.id)?.category === 'Source' && defOf.get(n.id)?.domain === 'ENCODED_STREAM');
  const primary = sources[0];
  if (sources.length > 1) for (const s of sources.slice(1)) warnings.push(new MoshpitError('NODE_UNKNOWN_KIND', { blockId, nodeId: s.id, why: 'secondary sources run as pass-through until M3 (D3)' }));
  let decodeFrom: NodeId | null = null;
  if (primary) {
    let cur: NodeId = primary.id;
    encodedChain.push(cur);
    for (;;) {
      const next = (outgoing.get(cur) ?? []).filter((e) => { const d = defOf.get(e.to.node); return d && encodedDomain(d); });
      if (next.length !== 1) break;
      cur = next[0].to.node;
      encodedChain.push(cur);
      const n = byId.get(cur)!;
      const nd = defOf.get(cur);
      if (nd && TRANSFORMS[nd.kind] && status.get(cur) !== 'BYPASSED' && status.get(cur) !== 'LEGACY' && status.get(cur) !== 'UNKNOWN') {
        const params: Record<string, number> = {};
        for (const p of nd.params) params[p.key] = numericBase(p, n.params[p.key]);
        encodedOps.push({ kind: 'map', op: nd.kind, params });
      } else if (n.kind === 'mosh.reorder' && status.get(cur) !== 'BYPASSED' && status.get(cur) !== 'LEGACY') {
        encodedOps.push({ kind: 'reorder', mode: String(n.params.mode ?? 'reverse') as 'reverse', from: Number(n.params.from ?? 0), to: Number(n.params.to ?? 30) });
      }
    }
    decodeFrom = cur;
  }
  for (const n of g.nodes) {
    const d = defOf.get(n.id);
    if (d && encodedDomain(d) && !encodedChain.includes(n.id) && !sources.includes(n)) err(new MoshpitError('GRAPH_DOMAIN_ORDER', { blockId, nodeId: n.id }));
  }
  // One decode boundary per block (§1f): only the chain's last encoded node may feed a frame input.
  for (const e of g.edges) {
    const fd = defOf.get(e.from.node), td = defOf.get(e.to.node);
    if (fd && td && encodedDomain(fd) && !encodedDomain(td) && e.from.node !== decodeFrom && encodedChain.includes(e.from.node)) {
      err(new MoshpitError('GRAPH_SECOND_DECODE', { blockId, edgeId: e.id, from: e.from.node, to: e.to.node }));
    }
  }

  // Topological order of the live GPU nodes. Delay outputs are available at frame start (they
  // read n−1), so an edge out of a Delay imposes no order.
  const gpu = [...live].filter((n) => { const d = defOf.get(n); return !d || !encodedDomain(d); });
  const indeg = new Map<NodeId, number>(gpu.map((n) => [n, 0]));
  const gpuSet = new Set(gpu);
  for (const e of g.edges) if (gpuSet.has(e.to.node) && gpuSet.has(e.from.node) && !isDelay(e.from.node)) indeg.set(e.to.node, indeg.get(e.to.node)! + 1);
  const ready = gpu.filter((n) => indeg.get(n) === 0).sort(stable(byId));
  const order: NodeId[] = [];
  while (ready.length) {
    const n = ready.shift()!;
    order.push(n);
    if (isDelay(n)) continue;
    for (const e of outgoing.get(n) ?? []) {
      if (!gpuSet.has(e.to.node)) continue;
      const v = indeg.get(e.to.node)! - 1;
      indeg.set(e.to.node, v);
      if (v === 0) { const cmp = stable(byId), x = e.to.node; let lo = 0, hi = ready.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(ready[m], x) <= 0) lo = m + 1; else hi = m; } ready.splice(lo, 0, x); }
    }
  }
  if (order.length !== gpu.length && !errors.some((e) => e.code === 'GRAPH_CYCLE')) err(new MoshpitError('GRAPH_CYCLE', { blockId }));

  // Slot allocation with reuse once a value's last consumer has run.
  let slotCount = 0;
  const free: number[] = [];
  const alloc = () => (free.length ? free.pop()! : slotCount++);
  const slotOf = new Map<NodeId, number>();
  const decodeSlot = alloc();
  if (decodeFrom) slotOf.set(decodeFrom, decodeSlot);
  const delaySlots = new Map<NodeId, number>();
  for (const n of order) if (isDelay(n)) { const s = slotCount++; delaySlots.set(n, s); slotOf.set(n, s); }
  const lastUse = new Map<NodeId, number>();
  order.forEach((n, i) => { if (!isDelay(n)) for (const e of inEdges.get(n) ?? []) lastUse.set(e.from.node, i); });
  for (const n of order) if (isDelay(n)) for (const e of wiresInto(n, 'in')) lastUse.set(e.from.node, order.length); // read at commit
  const freeAt = new Map<number, NodeId[]>();
  for (const [v, at] of lastUse) (freeAt.get(at) ?? freeAt.set(at, []).get(at)!).push(v);

  const steps: Step[] = [];
  const commits: { node: NodeId; from: number }[] = [];
  order.forEach((n, i) => {
    const inst = byId.get(n)!, def = defOf.get(n) ?? null, st = status.get(n);
    const declared = def?.inputs ?? [{ key: 'in', type: 'VideoFrame' } as never];
    const inputs: number[] = [], disc: (DisconnectedSemantics | null)[] = [], luma: boolean[] = [];
    for (const p of declared as NodeDef['inputs']) {
      const w = wiresInto(n, p.key)[0];
      const src = w ? slotOf.get(w.from.node) : undefined;
      inputs.push(src ?? -1);
      disc.push(src === undefined ? (p.disconnected ?? null) : null);
      const fromDef = w ? defOf.get(w.from.node) : null;
      luma.push(!!w && p.type === 'Field' && !!fromDef && fromDef.outputs.some((o) => o.type === 'VideoFrame'));
      if (src === undefined && p.cardinality === 'required-one' && def) err(new MoshpitError('GRAPH_REQUIRED_INPUT', { blockId, nodeId: n, port: p.key }));
    }
    if (isDelay(n)) { commits.push({ node: n, from: inputs[0] }); return; }
    const passThrough = st === 'UNKNOWN' || st === 'LEGACY' || st === 'BYPASSED';
    const isTerminalOutput = def?.kind === OUTPUT.kind;
    const output = isTerminalOutput ? inputs[0] : alloc();
    if (!isTerminalOutput) slotOf.set(n, output);
    steps.push({ node: n, def: def ?? OUTPUT, inputs, disconnected: disc, lumaInputs: luma, output, passThrough });
    // Free every value whose last consumer was this step.
    for (const v of freeAt.get(i) ?? []) if (slotOf.has(v) && !delaySlots.has(v) && v !== decodeFrom) free.push(slotOf.get(v)!);
  });

  const outputSlot = terminal ? (byId.get(terminal)?.kind === OUTPUT.kind ? steps.find((s) => s.node === terminal)?.output ?? -1 : slotOf.get(terminal) ?? -1) : -1;
  const stateful = order.filter((n) => { const d = defOf.get(n); return !!d && d.temporal.mode === 'past-dependent' && status.get(n) !== 'BYPASSED'; });
  let workingFrames = slotCount;
  // R-2: a history op counts the ring its params really allocate (echo taps: taps × spacing), not a flat 20.
  for (const n of order) {
    const d = defOf.get(n);
    if (!d || delaySlots.has(n)) continue;
    const num: Record<string, number> = {};
    for (const p of d.params) num[p.key] = numericBase(p, byId.get(n)!.params[p.key]);
    workingFrames += d.resources.workingTextures + (historyFrames(d.kind, num) ?? d.resources.stateFrames);
  }
  return {
    blockId, errors, warnings, ok: errors.length === 0, encodedChain, encodedOps, decodeSlot, steps, commits, delaySlots, terminal, outputSlot,
    slotCount, stateful, pastDependent: stateful.length > 0, status, workingFrames,
  };
}

const compatible = (from: string, to: string) => canWire(from as never, to as never).ok;

const stable = (byId: Map<NodeId, NodeInstance>) => (a: NodeId, b: NodeId) => {
  const pa = byId.get(a)!.position, pb = byId.get(b)!.position;
  return pa.x - pb.x || pa.y - pb.y || (a < b ? -1 : a > b ? 1 : 0);
};

function tarjan<T>(nodes: T[], next: (n: T) => T[]): T[][] {
  let i = 0;
  const idx = new Map<T, number>(), low = new Map<T, number>(), on = new Set<T>(), st: T[] = [], out: T[][] = [];
  const go = (v: T) => {
    idx.set(v, i); low.set(v, i); i++; st.push(v); on.add(v);
    for (const w of next(v)) {
      if (!idx.has(w)) { go(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) { const c: T[] = []; let w: T; do { w = st.pop()!; on.delete(w); c.push(w); } while (w !== v); out.push(c); }
  };
  for (const n of nodes) if (!idx.has(n)) go(n);
  return out;
}
