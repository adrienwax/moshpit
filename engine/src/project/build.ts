// Constructors for project objects. Every new object gets fresh identities (L6) and its
// definition's defaults, so the UI, the harness and tests build projects the same way.

import type {
  Block, BlockGraph, BlockId, BlockKind, EdgeId, GraphEdge, Lfo, LfoId, NodeId, NodeInstance, ParamValue, ProjectDoc,
  ProjectId, SourceId, PortKey,
} from '../model';
import { CURRENT_VERSIONS, newId } from '../model';
import { DECODE, DEF_BY_KIND, OUTPUT, SOURCE_CLIP } from '../nodes/defs';
import { MoshpitError } from '../errors';

export function newProject(name: string, opts: Partial<ProjectDoc['settings']> = {}): ProjectDoc {
  const working = opts.working ?? { w: 1920, h: 1080 };
  return {
    format: 'moshpit.project', versions: { ...CURRENT_VERSIONS }, id: newId<ProjectId>(), name, createdAt: new Date().toISOString(),
    settings: { fps: { num: 30, den: 1 }, working: { w: 1920, h: 1080 }, bpm: 120, seed: 1234, timeDisplay: 'musical', colour: { workingSpace: 'linear-rec709', intermediate: 'rgba16f' }, ...opts },
    resources: { sources: [], conforms: [] },
    timeline: { blocks: [] },
    modulators: { lfos: defaultLfos() },
    freezes: [],
    exportConfig: { format: 'mp4-h264', width: working.w, height: working.h, audio: true },
    view: { perBlock: {} },
  };
}

/** Moshpit 1's three global LFOs (types.ts DEFAULT_LFOS), re-expressed in beats (L23). */
export function defaultLfos(): Lfo[] {
  return [
    { id: newId<LfoId>(), label: 'LFO 1', shape: 'sine', period: 4, unit: 'beats', phase: 0 },
    { id: newId<LfoId>(), label: 'LFO 2', shape: 'sine', period: 1, unit: 'beats', phase: 0 },
    { id: newId<LfoId>(), label: 'LFO 3', shape: 'triangle', period: 8, unit: 'beats', phase: 0 },
  ];
}

export function newNode(kind: string, position = { x: 0, y: 0 }, params: Record<string, ParamValue> = {}): NodeInstance {
  const def = DEF_BY_KIND.get(kind);
  if (!def) throw new MoshpitError('NODE_UNKNOWN_KIND', { kind });
  const defaults: Record<string, ParamValue> = {};
  for (const p of def.params) defaults[p.key] = p.initial ?? p.default; // U2: a new node starts visible
  return { id: newId<NodeId>(), kind: def.kind, defVersion: def.defVersion, params: { ...defaults, ...params }, bindings: {}, position };
}

export function newEdge(from: NodeId, to: NodeId, fromPort = 'out', toPort = 'in'): GraphEdge {
  return { id: newId<EdgeId>(), from: { node: from, port: fromPort as PortKey }, to: { node: to, port: toPort as PortKey } };
}

/**
 * Every new block starts as clip → Decode → output: it plays its clip until you add nodes between.
 * Phase 1.1: the Decode is drawn, so the encoded / picture boundary is something you can see and
 * wire to (Mosh ops before it, effects after it). It changes no pixels (graph/decode.ts).
 */
export function defaultGraph(): BlockGraph {
  const src = newNode(SOURCE_CLIP.kind, { x: 0, y: 0 }), dec = newNode(DECODE.kind, { x: 300, y: 0 }), out = newNode(OUTPUT.kind, { x: 600, y: 0 });
  return { nodes: [src, dec, out], edges: [newEdge(src.id, dec.id), newEdge(dec.id, out.id)] };
}

export function newBlock(kind: BlockKind, sourceId: SourceId, inF: number, out: number, opts: Partial<Block> = {}): Block {
  return {
    id: newId<BlockId>(), kind, sourceId, in: inF, out, repeat: 1,
    seam: { kind: 'seam.mosh', defVersion: 1, keepInnerKeyframes: false },
    graph: defaultGraph(), audio: { mute: false }, refs: [], ...opts,
  };
}

/** Insert a chain of effect nodes between the source (or the last encoded node) and the Output. */
export function withChain(block: Block, kinds: { kind: string; params?: Record<string, ParamValue> }[]): Block {
  const src = block.graph.nodes.find((n) => n.kind === SOURCE_CLIP.kind)!;
  const out = block.graph.nodes.find((n) => n.kind === OUTPUT.kind)!;
  const dec = block.graph.nodes.find((n) => n.kind === DECODE.kind) ?? newNode(DECODE.kind);
  const mid = kinds.map((k) => newNode(k.kind, { x: 0, y: 0 }, k.params));
  // Mosh (encoded) ops before the Decode, picture ops after it, each group in the order given.
  const enc = mid.filter((n) => DEF_BY_KIND.get(n.kind)?.domain === 'ENCODED_STREAM'), pix = mid.filter((n) => !enc.includes(n));
  const chain = [src, ...enc, dec, ...pix, out];
  chain.forEach((n, i) => (n.position = { x: 150 * i, y: 0 }));
  return { ...block, graph: { nodes: chain, edges: chain.slice(1).map((n, i) => newEdge(chain[i].id, n.id)) } };
}

/** Duplicate a block with fresh identities throughout (T6: distinct instance identity, per-instance seed). */
export function duplicateBlock(b: Block): Block {
  const map = new Map<NodeId, NodeId>();
  const nodes = b.graph.nodes.map((n) => { const id = newId<NodeId>(); map.set(n.id, id); return { ...structuredClone(n), id }; });
  const edges = b.graph.edges.map((e) => ({ ...e, id: newId<EdgeId>(), from: { ...e.from, node: map.get(e.from.node)! }, to: { ...e.to, node: map.get(e.to.node)! } }));
  return { ...structuredClone(b), id: newId<BlockId>(), graph: { nodes, edges } };
}
