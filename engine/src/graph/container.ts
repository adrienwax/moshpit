// 3.2 Phase 3: containers compile by INLINING. A `group.container` node owns a sub-graph whose one
// `group.in` stands for the container's inputs and whose one `group.out` stands for its outputs.
// Before anything else sees a block graph (Stage 2, the freeze key), each container is replaced by
// its inner nodes and the wires through its boundary are joined up. What comes out is the flat graph
// Stage 2 already compiles, so the runtime, export and determinism see nothing new.
//
// Inner nodes keep their own ids, and where the rewiring is one-to-one the existing edge ids are
// kept (an inner wire keeps its id; a wire leaving the container keeps the outer id), so input-order
// lists still resolve. That makes collapse and unpack the same graph: identical plan, identical
// freeze key (which hashes wires by their endpoints), identical bytes.
//
// One level only (the validated design): a container inside a container is refused here.
import {
  MoshpitError, mapValue, type BlockGraph, type ContainerBody, type EdgeId, type EdgeType, type GraphEdge, type NodeId,
  type NodeDef, type NodeInstance, type ParamDef, type PortDef, type PortKey, type PortSpec,
} from '@moshpit/core';
import { DEF_BY_KIND } from '../nodes/defs';

export const CONTAINER_KIND = 'group.container';
export const GROUP_IN_KIND = 'group.in';
export const GROUP_OUT_KIND = 'group.out';
/** The CT has six dials: a container carries at most six macros (exposeMacro and validateLook both hold to it). */
export const MAX_MACROS = 6;

const asPort = (p: PortSpec): PortDef => ({ key: p.key, label: p.label, type: p.type, cardinality: 'required-one' });

/**
 * A node instance's ports (3.0b). Fixed per kind for every node but three: a container's are its
 * body's, and `group.in` / `group.out` show the enclosing body's in / out ports from the inside.
 * `body` is the container whose graph `n` sits in (absent at block level). The caller passes its
 * def lookup (the app's registry, or DEF_BY_KIND).
 */
export function portsOf(n: NodeInstance, dir: 'in' | 'out', defOf: (kind: string) => NodeDef | undefined, body?: ContainerBody): readonly PortDef[] {
  if (n.kind === CONTAINER_KIND) return (n.body?.ports[dir] ?? []).map(asPort);
  if (n.kind === GROUP_IN_KIND) return dir === 'out' ? (body?.ports.in ?? []).map(asPort) : [];
  if (n.kind === GROUP_OUT_KIND) return dir === 'in' ? (body?.ports.out ?? []).map(asPort) : [];
  const d = defOf(n.kind);
  return (dir === 'in' ? d?.inputs : d?.outputs) ?? [];
}

/** 3.3: a container's macros as ordinary params, so the inspector, its face and the CT treat it like any node. */
export function macroParams(c: NodeInstance): ParamDef[] {
  // The default (what a reset goes back to) is the look as authored, not the bottom of the range.
  return (c.kind === CONTAINER_KIND ? c.body?.macros ?? [] : []).map((m, i) => ({
    key: m.key, label: m.label, help: m.help, type: 'float', default: authoredAt(c, m), min: m.min, max: m.max, step: (m.max - m.min) / 100, onNode: true, ctOrder: (i < 6 ? i + 1 : undefined) as ParamDef['ctOrder'],
  }));
}

/**
 * Where a macro's dial sits: its value on the container once turned; before that, the position
 * that reproduces the param it drives (the Map-Range inverted), so the dial starts where the look is.
 */
export function macroValue(c: NodeInstance, key: string): number {
  const m = c.body?.macros.find((x) => x.key === key);
  if (!m) return 0;
  const raw = c.params[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.min(m.max, Math.max(m.min, raw));
  return authoredAt(c, m);
}

export interface Inlined {
  graph: BlockGraph;
  /** A container's id → the node feeding its Group output (a viewer on a container shows its output). */
  alias: Map<NodeId, NodeId>;
  errors: MoshpitError[];
}

type Problem = { code: 'CONTAINER_INVALID' | 'CONTAINER_NESTED'; why: string };

/** What is wrong with a container body, if anything. Used by the inline pass and by edits that build one. */
export function containerProblems(body: ContainerBody | undefined): Problem[] {
  if (!body || !body.graph || !Array.isArray(body.graph.nodes) || !Array.isArray(body.graph.edges) || !body.ports) return [{ code: 'CONTAINER_INVALID', why: 'no sub-graph' }];
  const out: Problem[] = [];
  const ins = body.graph.nodes.filter((n) => n.kind === GROUP_IN_KIND), outs = body.graph.nodes.filter((n) => n.kind === GROUP_OUT_KIND);
  if (ins.length !== 1) out.push({ code: 'CONTAINER_INVALID', why: `${ins.length} Group inputs (needs exactly 1)` });
  if (outs.length !== 1) out.push({ code: 'CONTAINER_INVALID', why: `${outs.length} Group outputs (needs exactly 1)` });
  if (body.graph.nodes.some((n) => n.kind === CONTAINER_KIND)) out.push({ code: 'CONTAINER_NESTED', why: 'a container inside a container' });
  const g = outs[0];
  if (g) for (const p of body.ports.out) if (!body.graph.edges.some((e) => e.to.node === g.id && e.to.port === p.key)) out.push({ code: 'CONTAINER_INVALID', why: `output ${p.key} is not wired inside` });
  return out;
}

function problemsOf(c: NodeInstance, outerIds: Set<NodeId>): Problem[] {
  const problems = containerProblems(c.body);
  const clash = c.body?.graph?.nodes?.find((n) => outerIds.has(n.id));
  if (clash) problems.push({ code: 'CONTAINER_INVALID', why: `inner node ${clash.id} shares an id with the block` });
  return problems;
}

/**
 * The macro values applied to the inner params they drive (a copy; the body is never mutated). A
 * macro the user has not turned (no value on the container) leaves its param as authored, so a
 * look stamped as a container renders exactly as its chain did. An int param gets a whole number.
 */
function withMacros(c: NodeInstance, body: ContainerBody): NodeInstance[] {
  if (!body.macros.length) return body.graph.nodes;
  const set = new Map<NodeId, Record<string, number>>();
  for (const m of body.macros) {
    const raw = c.params[m.key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const t = macroTarget(c, m.key, raw)!;
    set.set(t.node, { ...(set.get(t.node) ?? {}), [t.param]: t.value });
  }
  return body.graph.nodes.map((n) => (set.has(n.id) ? { ...n, params: { ...n.params, ...set.get(n.id) } } : n));
}

/**
 * What one macro value does: the inner node and param it drives and the value it gives them (the
 * Map-Range applied, a whole number for an int). The inline pass and the live param path (a drag,
 * a CT turn) both use it, so they cannot disagree.
 */
export function macroTarget(c: NodeInstance, key: string, value: number): { node: NodeId; param: string; value: number; kind: string } | null {
  const m = c.body?.macros.find((x) => x.key === key);
  const inner = m && c.body!.graph.nodes.find((n) => n.id === m.target.node);
  if (!m || !inner) return null;
  const v = Math.min(m.max, Math.max(m.min, value));
  const mapped = m.map ? mapValue(m.max > m.min ? (v - m.min) / (m.max - m.min) : 0, m.map) : v;
  const int = DEF_BY_KIND.get(inner.kind)?.params.find((p) => p.key === m.target.param)?.type === 'int';
  return { node: inner.id, param: m.target.param, value: int ? Math.round(mapped) : mapped, kind: inner.kind };
}

/** Where a macro's dial must sit to reproduce the param as authored (the Map-Range inverted). */
function authoredAt(c: NodeInstance, m: ContainerBody['macros'][number]): number {
  const inner = c.body!.graph.nodes.find((n) => n.id === m.target.node)?.params[m.target.param];
  if (typeof inner !== 'number') return m.default;
  const t = m.map ? (m.map.to === m.map.from ? 0 : (inner - m.map.from) / (m.map.to - m.map.from)) : (inner - m.min) / (m.max - m.min || 1);
  return m.min + Math.min(1, Math.max(0, t)) * (m.max - m.min);
}

/** Replace one valid container by its inner graph. */
function inlineOne(nodes: NodeInstance[], edges: GraphEdge[], c: NodeInstance): { nodes: NodeInstance[]; edges: GraphEdge[]; feeds?: NodeId } {
  const body = c.body!;
  const gin = body.graph.nodes.find((n) => n.kind === GROUP_IN_KIND)!;
  const gout = body.graph.nodes.find((n) => n.kind === GROUP_OUT_KIND)!;
  // A bypassed container (A/B a look in place) bypasses every node inside it but a Decode: the look's
  // effect is skipped, and a look from the stream to the picture still hands on a decoded picture.
  const inner = withMacros(c, body).filter((n) => n.id !== gin.id && n.id !== gout.id)
    .map((n) => (c.bypass && !n.bypass && n.kind !== 'decode.webcodecs' ? { ...n, bypass: true } : n));
  const into = edges.filter((e) => e.to.node === c.id); // outer → container port
  const outOf = edges.filter((e) => e.from.node === c.id); // container port → outer
  const joined: GraphEdge[] = [];
  for (const ie of body.graph.edges) {
    const fromIn = ie.from.node === gin.id, toOut = ie.to.node === gout.id;
    if (!fromIn && !toOut) { joined.push(ie); continue; }
    if (fromIn && toOut) { // a straight pass-through: outer source → outer target, keeping the outer id
      for (const a of into.filter((e) => e.to.port === ie.from.port)) for (const z of outOf.filter((e) => e.from.port === ie.to.port)) joined.push({ ...z, from: { ...a.from } });
      continue;
    }
    if (fromIn) { for (const a of into.filter((e) => e.to.port === ie.from.port)) joined.push({ ...ie, from: { ...a.from } }); continue; }
    for (const z of outOf.filter((e) => e.from.port === ie.to.port)) joined.push({ ...z, from: { ...ie.from } });
  }
  const feeds = body.graph.edges.find((e) => e.to.node === gout.id && e.from.node !== gin.id)?.from.node;
  return { nodes: [...nodes.filter((n) => n.id !== c.id), ...inner], edges: [...edges.filter((e) => e.to.node !== c.id && e.from.node !== c.id), ...joined], feeds };
}

export function inlineContainers(g: BlockGraph): Inlined {
  const containers = g.nodes.filter((n) => n.kind === CONTAINER_KIND);
  if (!containers.length) return { graph: g, alias: new Map(), errors: [] };
  const errors: MoshpitError[] = [];
  const alias = new Map<NodeId, NodeId>();
  const outerIds = new Set(g.nodes.map((n) => n.id));
  let nodes = g.nodes, edges = g.edges;
  for (const c of containers) {
    const problems = problemsOf(c, outerIds);
    // A broken container stays in the graph (Stage 2 then reports its wires); the rest go flat.
    if (problems.length) { for (const p of problems) errors.push(new MoshpitError(p.code, { nodeId: c.id, why: p.why })); continue; }
    const r = inlineOne(nodes, edges, c);
    nodes = r.nodes; edges = r.edges;
    if (r.feeds) alias.set(c.id, r.feeds);
  }
  return { graph: { ...g, nodes, edges }, alias, errors };
}

/** Unpack (3.4): the container's inner nodes replace it in the graph for good. The graph Stage 2 compiles. */
export function unpackContainer(g: BlockGraph, containerId: NodeId): BlockGraph {
  const c = g.nodes.find((n) => n.id === containerId && n.kind === CONTAINER_KIND);
  if (!c) throw new MoshpitError('CONTAINER_INVALID', { nodeId: containerId, why: 'not a container in this graph' });
  const problems = problemsOf(c, new Set(g.nodes.filter((n) => n.id !== c.id).map((n) => n.id)));
  if (problems.length) throw new MoshpitError(problems[0].code, { nodeId: containerId, why: problems[0].why });
  const r = inlineOne(g.nodes, g.edges, c);
  return { ...g, nodes: r.nodes, edges: r.edges };
}

export interface CollapseIds { container: NodeId; groupIn: NodeId; groupOut: NodeId; edge: () => EdgeId }

/**
 * Collapse (3.5): the selected nodes become one container. Its ports come from the wires crossing
 * the selection: one input per distinct outside source feeding in, one output per distinct inside
 * source feeding out, typed by what flows through them. Boundary wires keep their ids (the inner wire
 * from Group input keeps the original id, as does the outer wire leaving the container), so
 * unpacking gives the original graph back. The block's Source and Output, and containers (one
 * level only), cannot be collapsed.
 */
export function collapseSelection(g: BlockGraph, nodeIds: NodeId[], ids: CollapseIds, portType: (node: NodeInstance, port: PortKey) => EdgeType | undefined): BlockGraph {
  const pick = new Set(nodeIds);
  const sel = g.nodes.filter((n) => pick.has(n.id));
  if (!sel.length) throw new MoshpitError('CONTAINER_INVALID', { why: 'nothing selected' });
  if (sel.some((n) => n.kind === CONTAINER_KIND)) throw new MoshpitError('CONTAINER_NESTED', { why: 'the selection holds a container' });
  if (sel.some((n) => n.kind === 'source.clip' || n.kind === 'output.sink' || n.kind === GROUP_IN_KIND || n.kind === GROUP_OUT_KIND)) {
    throw new MoshpitError('CONTAINER_INVALID', { why: 'the block Source and Output stay outside a container' });
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const key = (r: GraphEdge['from']) => `${r.node}:${r.port}`;
  const split = (k: string) => { const i = k.lastIndexOf(':'); return { node: k.slice(0, i) as NodeId, port: k.slice(i + 1) as PortKey }; };
  const crossingIn = g.edges.filter((e) => pick.has(e.to.node) && !pick.has(e.from.node));
  const crossingOut = g.edges.filter((e) => pick.has(e.from.node) && !pick.has(e.to.node));
  const inPorts = new Map<string, PortSpec>(), outPorts = new Map<string, PortSpec>();
  const spec = (m: Map<string, PortSpec>, dir: 'in' | 'out', e: GraphEdge): PortSpec => ({ key: `${dir}${m.size + 1}` as PortKey, label: `${dir === 'in' ? 'In' : 'Out'} ${m.size + 1}`, type: portType(byId.get(e.from.node)!, e.from.port) ?? 'VideoFrame' });
  for (const e of crossingIn) if (!inPorts.has(key(e.from))) inPorts.set(key(e.from), spec(inPorts, 'in', e));
  for (const e of crossingOut) if (!outPorts.has(key(e.from))) outPorts.set(key(e.from), spec(outPorts, 'out', e));
  const xs = sel.map((n) => n.position.x), ys = sel.map((n) => n.position.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys);
  const gin: NodeInstance = { id: ids.groupIn, kind: GROUP_IN_KIND as never, defVersion: 1, params: {}, bindings: {}, position: { x: x0 - 200, y: y0 } };
  const gout: NodeInstance = { id: ids.groupOut, kind: GROUP_OUT_KIND as never, defVersion: 1, params: {}, bindings: {}, position: { x: x1 + 200, y: y0 } };
  const innerEdges: GraphEdge[] = [
    ...g.edges.filter((e) => pick.has(e.from.node) && pick.has(e.to.node)),
    ...crossingIn.map((e) => ({ ...e, from: { node: gin.id, port: inPorts.get(key(e.from))!.key } })),
    ...[...outPorts].map(([k, p]) => ({ id: ids.edge(), from: split(k), to: { node: gout.id, port: p.key } })),
  ];
  const container: NodeInstance = {
    id: ids.container, kind: CONTAINER_KIND as never, defVersion: 1, params: {}, bindings: {},
    position: { x: x0, y: y0 }, // where the selection began: that spot is free now (a midpoint could sit on a node left outside)
    body: { graph: { nodes: [gin, ...sel, gout], edges: innerEdges }, ports: { in: [...inPorts.values()], out: [...outPorts.values()] }, macros: [] },
  };
  const outerEdges: GraphEdge[] = [
    ...g.edges.filter((e) => !pick.has(e.from.node) && !pick.has(e.to.node)),
    ...[...inPorts].map(([k, p]) => ({ id: ids.edge(), from: split(k), to: { node: container.id, port: p.key } })),
    ...crossingOut.map((e) => ({ ...e, from: { node: container.id, port: outPorts.get(key(e.from))!.key } })),
  ];
  return { ...g, nodes: [...g.nodes.filter((n) => !pick.has(n.id)), container], edges: outerEdges };
}
