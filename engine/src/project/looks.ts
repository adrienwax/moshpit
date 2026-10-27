// Looks (3.2 Phase 3, D5): a library entry is a container definition (ComponentDef), and placing one
// stamps an owned copy (D1: copies, not live links; Update master is an explicit command). This
// replaces the Recipe fragment API, keeping its clamp-on-import rule, ported from Moshpit 2.0's
// `validateRecipe`: every known value clamped to its spec, unknown kinds kept verbatim (C4), the
// name trimmed to 80. A look file is untrusted input; one level of nesting is enforced here too.

import {
  MoshpitError, newId, type ComponentDef, type ComponentId, type ContainerBody, type EdgeId, type GraphEdge, type Macro,
  type NodeId, type NodeInstance, type ParamValue,
} from '@moshpit/core';
import { DEF_BY_KIND } from '../nodes/defs';
import { CONTAINER_KIND, MAX_MACROS, containerProblems } from '../graph/container';

/** What a look file holds on disk. */
export interface LookFile { schema: 'moshpit.look'; version: 1; look: ComponentDef }

const fail = (why: string): never => { throw new MoshpitError('RECIPE_INVALID', { why }); };
const name80 = (s: unknown, or: string) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, 80) : or);

/** A container on the canvas → a library definition: an owned copy of its body, macros included. */
export function lookFrom(container: NodeInstance, name: string, meta: { look?: string; does?: string } = {}): ComponentDef {
  if (container.kind !== CONTAINER_KIND || !container.body) fail('not a container');
  const { origin: _o, ...body } = structuredClone(container.body!);
  return { id: newId<ComponentId>(), name: name80(name, 'Look'), rev: 1, body: body as ContainerBody, params: savedMacroParams(container.params, body.macros), ...meta };
}

/** Only finite, known macro values travel with a look; keep absent knobs absent. */
function savedMacroParams(raw: unknown, macros: Macro[]): Record<string, ParamValue> {
  const values = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return Object.fromEntries(macros.flatMap((m) => {
    const v = values[m.key];
    return typeof v === 'number' && Number.isFinite(v) ? [[m.key, Math.min(m.max, Math.max(m.min, v))]] : [];
  }));
}

export const lookFile = (look: ComponentDef): LookFile => ({ schema: 'moshpit.look', version: 1, look });

/** Known params clamped to their spec; unknown kinds keep theirs (C4). */
function clampNode(n: NodeInstance): NodeInstance {
  if (!n || typeof n.id !== 'string' || typeof n.kind !== 'string') fail('a node without id or kind');
  const def = DEF_BY_KIND.get(n.kind);
  const params: Record<string, ParamValue> = { ...(n.params ?? {}) };
  if (def) for (const p of def.params) {
    const v = params[p.key];
    if (v === undefined) continue;
    if ((p.type === 'float' || p.type === 'int') && typeof v === 'number') params[p.key] = Math.min(p.max ?? v, Math.max(p.min ?? v, Number.isFinite(v) ? v : Number(p.default)));
    if (p.type === 'enum' && !p.options?.includes(String(v))) params[p.key] = p.default;
    if (p.type === 'bool') params[p.key] = !!v;
  }
  return { ...n, params, bindings: n.bindings ?? {}, position: n.position ?? { x: 0, y: 0 } };
}

/** Untrusted input (a look file) → a definition whose every known value is in range, one level deep. */
export function validateLook(raw: unknown): ComponentDef {
  if (!raw || typeof raw !== 'object') fail('not an object');
  const f = raw as Partial<LookFile>;
  if (f.schema !== 'moshpit.look' || f.version !== 1 || !f.look || typeof f.look !== 'object') fail('not a Moshpit look file');
  const d = f.look!;
  const b = d.body as Partial<ContainerBody> | undefined;
  if (!b || !b.graph || !Array.isArray(b.graph.nodes) || !Array.isArray(b.graph.edges) || !b.ports) fail('no body');
  const nodes = b!.graph!.nodes.map(clampNode);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (b!.graph!.edges as GraphEdge[]).filter((e) => e && ids.has(e.from?.node) && ids.has(e.to?.node));
  const macros = (Array.isArray(b!.macros) ? b!.macros : []).filter((m): m is Macro =>
    !!m && typeof m.key === 'string' && ids.has(m.target?.node) && Number.isFinite(m.min) && Number.isFinite(m.max) && m.max > m.min,
  ).slice(0, MAX_MACROS).map((m) => ({ ...m, label: name80(m.label, m.key), default: Math.min(m.max, Math.max(m.min, Number.isFinite(m.default) ? m.default : m.min)) })); // audit P2: six at most, as exposeMacro
  const body: ContainerBody = { graph: { nodes, edges }, ports: { in: b!.ports!.in ?? [], out: b!.ports!.out ?? [] }, macros };
  const problem = containerProblems(body)[0];
  if (problem) fail(problem.why);
  return { id: (typeof d.id === 'string' ? d.id : newId()) as ComponentId, name: name80(d.name, 'Look'), rev: Number.isInteger(d.rev) && d.rev > 0 ? d.rev : 1, body, ...(d.params !== undefined ? { params: savedMacroParams(d.params, macros) } : {}), look: d.look, does: d.does };
}

/**
 * Place a look: a container node owning a fresh copy of the definition's body. Every inner node,
 * wire and macro target gets a new id (L6), so a look can be stamped any number of times into one
 * block; the copy remembers where it came from (origin) for Update from master.
 */
export function stampLook(def: ComponentDef, position: { x: number; y: number }, params?: Record<string, ParamValue>): NodeInstance {
  const map = new Map<NodeId, NodeId>();
  const nodes = def.body.graph.nodes.map((n) => { const id = newId<NodeId>(); map.set(n.id, id); return { ...structuredClone(n), id }; });
  const edgeIds = new Map(def.body.graph.edges.map(e => [e.id, newId<EdgeId>()]));
  const edges = def.body.graph.edges.map((e) => ({ ...structuredClone(e), id: edgeIds.get(e.id)!, from: { ...e.from, node: map.get(e.from.node)! }, to: { ...e.to, node: map.get(e.to.node)! } }));
  for (const node of nodes) if (node.inputOrder) node.inputOrder = Object.fromEntries(Object.entries(node.inputOrder).map(([port, order]) => [port, order.map(id => edgeIds.get(id) ?? id)]));
  const macros = def.body.macros.map((m) => ({ ...structuredClone(m), target: { ...m.target, node: map.get(m.target.node)! } }));
  return {
    id: newId<NodeId>(), kind: CONTAINER_KIND as never, defVersion: 1, label: def.name, params: { ...savedMacroParams(def.params, macros), ...savedMacroParams(params, macros) }, bindings: {}, position,
    body: { graph: { nodes, edges }, ports: structuredClone(def.body.ports), macros, origin: { component: def.id, rev: def.rev } },
  };
}
