// L24: the single graph store. The ProjectDoc is the only source of truth; the strip, the
// canvas, the inspector and the timeline are projections that dispatch these commands.
// Every committed edit is pushed to the engine (EngineClient.updateProject).
import type {
  Block, BlockGraph, BlockId, Chapter, ComponentDef, ComponentId, ContainerBody, ConformedSource, EdgeId, FreezeTarget, Lfo, LfoId, NodeId, NodeInstance, ParamBinding,
  ParamValue, PortKey, ProjectDoc, ProjectValue, SourceClip, SourceId, ValueId, ValueLink,
} from '@moshpit/engine';
import { CONTAINER_KIND, GROUP_IN_KIND, GROUP_OUT_KIND, MAX_MACROS, MoshpitError, lookFrom, stampLook, OUTPUT, SOURCE_CLIP, collapseSelection, compileBlockGraph, domainOrderOk, isPlaceable, macroParams, mapValue, newId, portsOf, unpackContainer } from '@moshpit/engine';
import { freeze, produce } from 'immer';
import { confirmAction, toast } from '../qol/qol';
import { createStore, useStore } from './store';
import { engine, engineKind, defOf } from '../engine';
import { demoProject, defaults } from '../engine/mockProject';
import { compatible } from '../engine/catalog';
import { settingsStore } from './ui';
import { getProjectSession, jobStore } from './jobs';

export interface HistoryEntry {
  label: string;
  at: number;
  /** The document *before* this edit. */
  before: ProjectDoc;
  key?: string;
  /** Stable through undo/redo (the saved marker compares it); a new id whenever the entry changes. */
  id: number;
  /** The gesture that made it: every commit in one press (a drag, a multi-part delete) is one step. */
  g?: number;
}

interface ProjectState {
  doc: ProjectDoc;
  past: HistoryEntry[];
  future: HistoryEntry[];
}

const HISTORY_CAP = 200;
const COALESCE_MS = 1500;

/** A new, empty project (fresh ids, current section versions, default settings and LFOs). */
export function emptyDoc(): ProjectDoc {
  const d = demoProject();
  // New projects take their export defaults from Settings → Media defaults.
  const def = settingsStore.get().defaults;
  const format = ({ HAP: 'hap', ProRes: 'prores-422hq', 'H.264': 'mp4-h264' } as const)[def.codec as 'HAP'] ?? 'mp4-h264';
  const [w, h] = def.resolution.split('×').map(Number);
  const exportConfig = { format, width: w || 1920, height: h || 1080, audio: true, audioMirror: true };
  const fps = ['24', '25', '30', '50', '60'].includes(def.fps) ? Number(def.fps) : 60;
  return { ...d, id: newId(), name: 'Untitled', createdAt: new Date().toISOString(), settings: { ...d.settings, fps: { num: fps, den: 1 }, working: { w: exportConfig.width, h: exportConfig.height } }, resources: { sources: [], conforms: [] }, timeline: { blocks: [] }, freezes: [], exportConfig, view: { perBlock: {} } };
}

/** The mock gets the prototype's demo project; the real engine starts empty (its media must be imported for real). */
const initialDoc = (): ProjectDoc => (engineKind === 'mock' ? demoProject() : emptyDoc());

export const projectStore = createStore<ProjectState>({ doc: freeze(initialDoc(), true), past: [], future: [] });
engine.updateProject(projectStore.get().doc);
const startupDoc = projectStore.get().doc;
/** Called after preferences load and before controls/UI mount. Never replace an opened or edited doc. */
export function initializeProjectDefaults() {
  if (engineKind === 'mock' || projectStore.get().doc !== startupDoc) return;
  const doc = freeze(emptyDoc(), true);
  projectStore.set({ doc, past: [], future: [] });
  engine.updateProject(doc);
}

export const useProject = <U>(sel: (d: ProjectDoc) => U) => useStore(projectStore, (s) => sel(s.doc));
export const useHistory = () => useStore(projectStore, (s) => s.past);
export const useCanRedo = () => useStore(projectStore, (s) => s.future.length > 0);
export const getDoc = () => projectStore.get().doc;

/**
 * Apply an undoable edit. Inside a gesture (beginGesture … endGesture, or transact) every commit
 * folds into one history step: a whole drag, however slow, is one undo. Outside one, `key`
 * coalesces a quick burst of same-field edits (arrow-key nudges) for COALESCE_MS.
 *
 * Checkpoint 1, A-4: copy-on-write. `mutate` edits an Immer draft; only the objects on the changed
 * paths are copied, everything else is shared with the previous doc and so with every history
 * snapshot. That sharing is safe because every doc in the store is frozen: an edit that is not
 * through commit (or a spread copy, like setParam's) throws instead of corrupting history.
 */
export function commit(label: string, mutate: (d: ProjectDoc) => void, key?: string) {
  projectStore.set((s) => {
    const next = produce(s.doc, (d) => { mutate(d as ProjectDoc); }); // the braces drop any return value
    syncEngine(next);
    return { doc: next, past: pushHistory(s, label, key), future: [] };
  });
}

let entrySeq = 0, gesture = 0, gestureSeq = 0;

// Phase 0.1a: inside a gesture (a trim drag moves dozens of times a second) the engine hears the
// newest document at most once per frame, and the last one when the gesture ends. Every move used
// to post the whole project to the worker, which recompiled it each time.
let pendingSync = false;
let syncTimer: number | ReturnType<typeof setTimeout> | null = null;
const nextFrame = (fn: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
/** Sends the store's current document (not a queued snapshot), so a fast setParam in between is never lost. */
function flushSync() {
  syncTimer = null;
  if (pendingSync) engine.updateProject(projectStore.get().doc);
  pendingSync = false;
}
function syncEngine(doc: ProjectDoc) {
  if (!gesture) {
    pendingSync = false;
    return engine.updateProject(doc);
  }
  pendingSync = true;
  if (syncTimer == null) syncTimer = nextFrame(flushSync);
}

/** Start a gesture (pointer down on a scrub, a trim edge): its commits become one undo step. */
export function beginGesture() {
  gesture = ++gestureSeq;
}
export function endGesture() {
  gesture = 0;
  if (pendingSync) flushSync(); // the release always reaches the engine, at once
}
/** Several commits as one undo step (a delete of nodes and wires, a recipe's effects). Nests. */
export function transact<T>(fn: () => T): T {
  if (gesture) return fn();
  beginGesture();
  try {
    return fn();
  } finally {
    endGesture();
  }
}

/** The undo step for an edit of `s.doc`: same gesture, or a quick same-key burst, coalesces. */
function pushHistory(s: ProjectState, label: string, key?: string) {
  const last = s.past[s.past.length - 1];
  const now = Date.now();
  const same = gesture ? last?.g === gesture : !!key && last?.key === key && !last.g && now - last.at < COALESCE_MS;
  return same
    ? [...s.past.slice(0, -1), { ...last, label: key && key === last.key ? label : last.label, at: now, id: ++entrySeq }] // a drag's label ends on its final value
    : [...s.past, { label, at: now, before: s.doc, key, id: ++entrySeq, g: gesture || undefined }].slice(-HISTORY_CAP);
}

export const topEntry = (): HistoryEntry | undefined => projectStore.get().past.at(-1);

/**
 * A toast's Undo: undoes exactly the edit the toast reports, and only while it is still the last
 * one. It used to call the global undo, which undid whatever came after instead.
 */
export function undoAction(): { label: string; run: () => void } {
  const mine = topEntry()?.id;
  return {
    label: 'Undo',
    run: () => {
      if (mine !== undefined && topEntry()?.id === mine) return void undo();
      toast('Other edits came after this one: use Ctrl+Z or History to step back', { kind: 'warn' });
    },
  };
}

/** View state (selection, viewer, pan/zoom — D3): saved with the project, never an undo step. */
export function setView(mutate: (v: ProjectDoc['view']) => void) {
  projectStore.set((s) => {
    const view = produce(s.doc.view, (v) => { mutate(v as ProjectDoc['view']); });
    return { ...s, doc: { ...s.doc, view } };
  });
}

/** The view after the document moved under it: no selection pointing at a block that is gone. */
function keepView(view: ProjectDoc['view'], d: ProjectDoc): ProjectDoc['view'] {
  return view.activeBlock && !d.timeline.blocks.some((b) => b.id === view.activeBlock) ? { ...view, activeBlock: undefined } : view;
}

/** Undo the last step. Returns its label (null when there is nothing to undo). */
export function undo(): string | null {
  const e = projectStore.get().past.at(-1);
  if (!e) return null;
  projectStore.set((s) => {
    engine.updateProject(e.before);
    return { doc: { ...e.before, view: keepView(s.doc.view, e.before) }, past: s.past.slice(0, -1), future: [...s.future, { ...e, before: s.doc }] };
  });
  return e.label;
}

/** Redo the last undone step. Returns its label (null when there is nothing to redo). */
export function redo(): string | null {
  const e = projectStore.get().future.at(-1);
  if (!e) return null;
  projectStore.set((s) => {
    engine.updateProject(e.before);
    return { doc: { ...e.before, view: keepView(s.doc.view, e.before) }, past: [...s.past, { ...e, before: s.doc }], future: s.future.slice(0, -1) };
  });
  return e.label;
}

/**
 * Undo or redo from the keyboard, the top bar or the History drawer, and say what moved: undo is
 * global (graph, timeline, settings alike), so in OUT Ctrl+Z can undo a graph edit. Not while a
 * confirm dialog waits for an answer: the document must not move under it.
 */
export function stepHistory(back: boolean) {
  if (document.querySelector('[role=alertdialog]')) return;
  const label = back ? undo() : redo();
  toast(label ? `${back ? 'Undid' : 'Redid'}: ${label}` : `Nothing to ${back ? 'undo' : 'redo'}`, { tag: 'undo', ms: 1800 });
}

/** Restore to just before history entry `i` (the History pane's click-to-restore). Undoable. */
export function restoreTo(i: number) {
  const e = projectStore.get().past[i];
  if (!e) return;
  // The whole document, as undo and redo do (bug hunt): Object.assign kept fields the snapshot never
  // had, so restoring to before your looks or Values existed left them in. Undoable like any step.
  projectStore.set((s) => {
    const next = { ...e.before, view: keepView(s.doc.view, e.before) };
    engine.updateProject(next);
    return { doc: next, past: pushHistory(s, `Restored "${e.label}"`), future: [] };
  });
}

// ---------- lookups ----------

export const blockById = (d: ProjectDoc, id?: BlockId) => d.timeline.blocks.find((b) => b.id === id);
export const activeBlock = (d: ProjectDoc): Block | undefined => blockById(d, d.view.activeBlock) ?? d.timeline.blocks[0];
export const sourceById = (d: ProjectDoc, id?: SourceId) => d.resources.sources.find((s) => s.id === id);

function mutBlock(d: ProjectDoc, id: BlockId): Block {
  const b = blockById(d, id);
  if (!b) throw new MoshpitError('PARAM_UNKNOWN', { blockId: id });
  return b;
}

/**
 * 3.0b: where a graph edit lands. A block id is the block's own graph; `{ blockId, container }` is
 * the graph inside that block's container (one level: a container holds no container). Every node
 * and wire command takes one, so the canvas edits a container's insides with the same commands.
 */
export type GraphAt = BlockId | { blockId: BlockId; container?: NodeId };
export const blockOf = (at: GraphAt): BlockId => (typeof at === 'string' ? at : at.blockId);

/** The graph `at` names, and the container body it sits in (absent at block level). Throws if gone. */
export function graphAt(d: ProjectDoc, at: GraphAt): { graph: BlockGraph; body?: ContainerBody } {
  const b = mutBlock(d, blockOf(at));
  const cid = typeof at === 'string' ? undefined : at.container;
  if (!cid) return { graph: b.graph };
  const c = b.graph.nodes.find((n) => n.id === cid && n.kind === CONTAINER_KIND);
  if (!c?.body) throw new MoshpitError('PARAM_UNKNOWN', { container: cid });
  return { graph: c.body.graph, body: c.body };
}
const findGraph = (d: ProjectDoc, at: GraphAt) => { try { return graphAt(d, at); } catch { return undefined; } };

/** A block's nodes and, one level down, every container's inner nodes (lists and clean-ups see them all). */
export const nodesOf = (b: Block): NodeInstance[] => b.graph.nodes.flatMap((n) => (n.kind === CONTAINER_KIND && n.body ? [n, ...n.body.graph.nodes] : [n]));

/** A node instance's params: its def's, or a container's macros (3.3). */
export const paramsOf = (n: NodeInstance) => (n.kind === CONTAINER_KIND ? macroParams(n) : defOf(n.kind)?.params ?? []);

/** A node instance's ports: its def's, or a container's / Group node's own (engine portsOf). */
export const ports = (n: NodeInstance, dir: 'in' | 'out', body?: ContainerBody) => portsOf(n, dir, defOf, body);

/**
 * The scope a node lives in: `at` itself, or, for a plain block id, one level down in the block's
 * containers. So every node command (the inspector, the LFO and Value panes, a CT write) reaches an
 * inner node by its id without knowing where it sits.
 */
export function scopeOfNode(d: ProjectDoc, at: GraphAt, nodeId: string): GraphAt {
  if (typeof at !== 'string') return at;
  const b = blockById(d, at);
  if (!b || b.graph.nodes.some((n) => n.id === nodeId)) return at;
  const c = b.graph.nodes.find((n) => n.kind === CONTAINER_KIND && n.body?.graph.nodes.some((x) => x.id === nodeId));
  return c ? { blockId: at, container: c.id } : at;
}

const mutNode = (d: ProjectDoc, at: GraphAt, nodeId: NodeId) => {
  const n = graphAt(d, scopeOfNode(d, at, nodeId)).graph.nodes.find((x) => x.id === nodeId);
  if (!n) throw new MoshpitError('PARAM_UNKNOWN', { nodeId });
  return n;
};

const nodeLabel = (n: NodeInstance) => n.label ?? defOf(n.kind)?.label ?? n.kind;

// ---------- selection / view ----------

export function selectBlock(id: BlockId) {
  setView((v) => {
    v.activeBlock = id;
  });
}

export function selectNode(blockId: BlockId, nodeId: NodeId | null) {
  setView((v) => {
    const pb = (v.perBlock[blockId] ??= { pan: { x: 0, y: 0 }, zoom: 1, selected: [] });
    pb.selected = nodeId ? [nodeId] : [];
  });
}

/** TD-style viewer flag: one viewed node per block. */
export function toggleViewer(blockId: BlockId, nodeId: NodeId) {
  setView((v) => {
    const pb = (v.perBlock[blockId] ??= { pan: { x: 0, y: 0 }, zoom: 1, selected: [] });
    pb.viewer = pb.viewer === nodeId ? undefined : nodeId;
  });
}

export function setBlockPanZoom(blockId: BlockId, pan: { x: number; y: number }, zoom: number) {
  setView((v) => {
    const pb = (v.perBlock[blockId] ??= { pan, zoom, selected: [] });
    pb.pan = pan;
    pb.zoom = zoom;
  });
}

// ---------- params ----------

export function setParam(where: GraphAt, nodeId: NodeId, key: string, value: ParamValue) {
  const d = getDoc();
  const at = scopeOfNode(d, where, nodeId);
  const blockId = blockOf(at);
  const n = findGraph(d, at)?.graph.nodes.find((x) => x.id === nodeId);
  const pdef = n && paramsOf(n).find((p) => p.key === key);
  if (!n || !pdef) throw new MoshpitError('PARAM_UNKNOWN', { nodeId, key });
  if (typeof value === 'number' && ((pdef.min !== undefined && value < pdef.min) || (pdef.max !== undefined && value > pdef.max))) {
    throw new MoshpitError('PARAM_OUT_OF_RANGE', { key, value });
  }
  // Audit P2: a container macro set to its default (a reset: the look as authored) is UNTURNED, not
  // written through the Map-Range's float round trip (a few ULPs off, which would stale a freeze).
  if (n.kind === CONTAINER_KIND && typeof value === 'number' && value === pdef.default) {
    if (n.params[key] === undefined) return;
    return commit(`Reset ${nodeLabel(n)} ${pdef.label} (as the look made it)`, (doc) => void delete mutNode(doc, at, nodeId).params[key], `p:${nodeId}:${key}`);
  }
  const label = `${nodeLabel(n)} ${pdef.label} → ${typeof value === 'number' ? +value.toFixed(3) : String(value)}`;
  // A list param, or a node inside a container: the full path (the fast path rewrites block-level nodes only).
  // A list param, or a node inside a container: the full path (the fast path rewrites block-level nodes;
  // a container's macro is block-level, and the engine service maps it to the inner param it drives).
  if (typeof value === 'object' || typeof at !== 'string') return commit(label, (doc) => void (mutNode(doc, at, nodeId).params[key] = value), `p:${nodeId}:${key}`);
  // R-1: a drag tick copies only the edited node (the rest of the doc is shared, never mutated)
  // and sends the engine the edit alone: no whole-doc clone, no whole-doc post, no recompile.
  projectStore.set((s) => {
    const blocks = s.doc.timeline.blocks.map((b) => (b.id !== blockId ? b : { ...b, graph: { ...b.graph, nodes: b.graph.nodes.map((x) => (x.id !== nodeId ? x : { ...x, params: { ...x.params, [key]: value } })) } }));
    const next = { ...s.doc, timeline: { ...s.doc.timeline, blocks } };
    engine.setParam(next, blockId, nodeId, key, value);
    return { doc: next, past: pushHistory(s, label, `p:${nodeId}:${key}`), future: [] };
  });
}

/** Several params of one node as one undo step (a preset, a dice roll). Unknown keys are skipped. */
export function setParams(at: GraphAt, nodeId: NodeId, values: Record<string, ParamValue>, label: string) {
  const n = findGraph(getDoc(), scopeOfNode(getDoc(), at, nodeId))?.graph.nodes.find((x) => x.id === nodeId);
  const def = n && (n.kind === CONTAINER_KIND ? { params: macroParams(n) } : defOf(n.kind));
  if (!n || !def) throw new MoshpitError('PARAM_UNKNOWN', { nodeId });
  commit(label, (d) => {
    const node = mutNode(d, at, nodeId);
    // E-2: preset and dice values are clamped to the def's range (they used to reach the shader as is).
    for (const [k, v] of Object.entries(values)) {
      const p = def.params.find((x) => x.key === k);
      if (p) node.params[k] = typeof v === 'number' ? Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v)) : v;
    }
  });
}

// ---------- graph ----------

export interface PortRef {
  node: NodeId;
  port: PortKey;
}

function portType(n: NodeInstance | undefined, key: PortKey, dir: 'in' | 'out', body?: ContainerBody) {
  return n ? ports(n, dir, body).find((p) => p.key === key) : undefined;
}

/** L3/L5 checks shared by the canvas's live validation and the commit. Returns an error code or null. */
// Phase 0.1a: React Flow asks this for every socket the pointer crosses during a wire drag, and
// the second-decode check compiles the whole block graph. A graph is immutable between commits, so
// one answer per graph object and wire is enough.
const wireVerdicts = new WeakMap<object, Map<string, MoshpitError | null>>();

export function connectionError(at: GraphAt, from: PortRef, to: PortRef): MoshpitError | null {
  const d = getDoc();
  const b = blockById(d, blockOf(at));
  const scope = findGraph(d, at);
  if (!b || !scope) return new MoshpitError('PARAM_UNKNOWN');
  let seen = wireVerdicts.get(scope.graph);
  if (!seen) wireVerdicts.set(scope.graph, (seen = new Map()));
  const k = `${from.node}:${from.port}>${to.node}:${to.port}`;
  if (!seen.has(k)) seen.set(k, wireError(b, at, scope, from, to));
  return seen.get(k)!;
}

/** The block graph with `g` as the graph at `at` (itself at block level; the container's body inside one). */
function withGraphAt(b: Block, at: GraphAt, g: BlockGraph): BlockGraph {
  if (typeof at === 'string' || !at.container) return g;
  return { ...b.graph, nodes: b.graph.nodes.map((n) => (n.id === at.container && n.body ? { ...n, body: { ...n.body, graph: g } } : n)) };
}

function wireError(b: Block, at: GraphAt, scope: { graph: BlockGraph; body?: ContainerBody }, from: PortRef, to: PortRef): MoshpitError | null {
  const g = scope.graph;
  const src = portType(g.nodes.find((n) => n.id === from.node), from.port, 'out', scope.body);
  const dst = portType(g.nodes.find((n) => n.id === to.node), to.port, 'in', scope.body);
  if (!src || !dst) return new MoshpitError('GRAPH_TYPE_MISMATCH', { from, to });
  if (!compatible(src.type, dst.type) || (src.subtype && dst.subtype && src.subtype !== dst.subtype)) {
    return new MoshpitError('GRAPH_TYPE_MISMATCH', { from: src.type, to: dst.type });
  }
  // B1: encoded-domain (Mosh) nodes only before the decode boundary.
  const fromDef = defOf(g.nodes.find((n) => n.id === from.node)!.kind);
  const toDef = defOf(g.nodes.find((n) => n.id === to.node)!.kind);
  if (fromDef && toDef && !domainOrderOk(fromDef, toDef)) return new MoshpitError('GRAPH_DOMAIN_ORDER', { from: fromDef.kind, to: toDef.kind });
  if (dst.cardinality !== 'many' && g.edges.some((e) => e.to.node === to.node && e.to.port === to.port)) {
    return new MoshpitError('GRAPH_PORT_OCCUPIED', { to });
  }
  if (from.node === to.node) return new MoshpitError('GRAPH_CYCLE');
  // Cycle check: does `to` already reach `from`? Only a Delay may close a loop (L10).
  const reach = (n: NodeId, seen = new Set<NodeId>()): boolean =>
    n === from.node || (!seen.has(n) && (seen.add(n), g.edges.filter((e) => e.from.node === n).some((e) => reach(e.to.node, seen))));
  const toKind = g.nodes.find((n) => n.id === to.node)?.kind;
  if (toKind !== 'route.delay' && reach(to.node)) return new MoshpitError('GRAPH_CYCLE');
  // One decode per block: a wire that would make a second decode point is refused here, with its
  // reason, instead of failing every render later (Waxy wired Source to an effect and to the Mosh
  // chain; nothing rendered). The engine's own compiler decides, so editor and render agree.
  // Only a wire out of the encoded stream can make a second decode point; a picture wire never does,
  // so it skips the trial compile (every socket runs this check while a wire is dragged: Phase 1.2).
  if (src.type !== 'EncodedVideoStream') return null;
  // Compiled as the whole block (a container's insides are inlined into it), so the one-decode rule
  // is checked where it applies.
  const trial = withGraphAt(b, at, { ...g, edges: [...g.edges, { id: 'trial' as EdgeId, from, to }] });
  const second = compileBlockGraph(b.id, trial).errors.find((e) => e.code === 'GRAPH_SECOND_DECODE');
  if (second) return second;
  return null;
}

export function connect(at: GraphAt, from: PortRef, to: PortRef) {
  const err = connectionError(at, from, to);
  if (err) throw err;
  commit('Connected wire', (d) => {
    graphAt(d, at).graph.edges.push({ id: newId<EdgeId>(), from, to });
  });
}

export function removeEdges(at: GraphAt, ids: string[]) {
  if (!ids.length) return;
  commit(ids.length > 1 ? `Removed ${ids.length} wires` : 'Removed wire', (d) => {
    const g = graphAt(d, at).graph;
    g.edges = g.edges.filter((e) => !ids.includes(e.id));
  });
}

export function addNode(at: GraphAt, kind: string, position: { x: number; y: number }, wireFrom?: PortRef): NodeId {
  const def = defOf(kind);
  if (!def) throw new MoshpitError('NODE_UNKNOWN_KIND', { kind });
  if (!isPlaceable(def)) throw new MoshpitError('NODE_UNKNOWN_KIND', { kind, why: 'every block already has its one Source and Output' });
  const node: NodeInstance = { id: newId<NodeId>(), kind: def.kind, defVersion: def.defVersion, params: defaults(def), bindings: {}, position };
  commit(`Added ${def.label}`, (d) => {
    const { graph: g, body } = graphAt(d, at);
    g.nodes.push(node);
    if (wireFrom) {
      const fromNode = g.nodes.find((n) => n.id === wireFrom.node);
      const outType = portType(fromNode, wireFrom.port, 'out', body)?.type;
      const target = outType && def.inputs.find((p) => compatible(outType, p.type));
      if (target) g.edges.push({ id: newId<EdgeId>(), from: wireFrom, to: { node: node.id, port: target.key } });
    }
  });
  return node.id;
}

export function removeNodes(at: GraphAt, wanted: string[]) {
  // E-1: a block keeps its Source and its last Output; deleting them left GRAPH_NO_OUTPUT and a
  // broken preview until undo. They are skipped, and the user is told why.
  const nodes = findGraph(getDoc(), at)?.graph.nodes ?? [];
  const outputs = nodes.filter((n) => n.kind === OUTPUT.kind).map((n) => n.id);
  // A container's Group input / output stay too: they are its ports (3.2).
  const kept = new Set<string>(nodes.filter((n) => n.kind === SOURCE_CLIP.kind || n.kind === GROUP_IN_KIND || n.kind === GROUP_OUT_KIND).map((n) => n.id));
  if (outputs.length && outputs.every((o) => wanted.includes(o))) kept.add(outputs[0]);
  const ids = wanted.filter((id) => !kept.has(id));
  if (kept.size && wanted.some((id) => kept.has(id))) {
    const group = typeof at !== 'string' && !!at.container;
    toast(group ? "Group input and Group output stay: they are the container's ports." : ids.length ? 'Kept the Source and Output: every block needs one of each.' : 'The Source and Output stay: every block needs one of each.');
  }
  if (!ids.length) return;
  commit(ids.length > 1 ? `Deleted ${ids.length} nodes` : `Deleted ${nodeLabel(nodes.find((n) => n.id === ids[0])!)}`, (d) => {
    const g = graphAt(d, at).graph;
    // Phase 1 hardening: a pass-through (Decode, Reroute, Null) changes nothing, so deleting one
    // keeps its wire (Blender's dissolve): what fed it now feeds what it fed. Deleting a Decode used
    // to leave every picture input after it unwired, and the block stopped rendering.
    const feederOf = (id: string) => {
      const seen = new Set<string>();
      let cur: string | undefined = id;
      while (cur && ids.includes(cur) && PASS_THROUGH.has(g.nodes.find((x) => x.id === cur)?.kind ?? '') && !seen.has(cur)) {
        seen.add(cur);
        const ins = g.edges.filter((e) => e.to.node === cur);
        if (ins.length !== 1) return undefined;
        if (!ids.includes(ins[0].from.node)) return ins[0].from;
        cur = ins[0].from.node;
      }
      return undefined;
    };
    const bridged = g.edges.filter((e) => ids.includes(e.from.node) && !ids.includes(e.to.node)).flatMap((e) => {
      const from = feederOf(e.from.node);
      return from ? [{ ...e, from: { ...from } }] : [];
    });
    g.nodes = g.nodes.filter((n) => !ids.includes(n.id));
    g.edges = [...g.edges.filter((e) => !ids.includes(e.from.node) && !ids.includes(e.to.node)), ...bridged];
  });
}

/** Nodes that pass their input through unchanged: deleting one keeps its wire. */
const PASS_THROUGH = new Set(['decode.webcodecs', 'route.reroute', 'route.reroute-stream', 'route.null']);

export function moveNodes(at: GraphAt, moves: { id: string; x: number; y: number }[]) {
  commit('Moved nodes', (d) => {
    const g = graphAt(d, at).graph;
    moves.forEach((m) => {
      const n = g.nodes.find((x) => x.id === m.id);
      if (n) n.position = { x: m.x, y: m.y };
    });
  }, `move:${blockOf(at)}:${moves.map((m) => m.id).join()}`);
}

/** First input of `n` that accepts `fromType` (mirrors stage 2's implicit conversions). */
function inputFor(n: NodeInstance, fromType: string, body?: ContainerBody) {
  return ports(n, 'in', body).find((p) => compatible(fromType, p.type));
}
const firstOut = (n: NodeInstance, body?: ContainerBody) => ports(n, 'out', body)[0];

/** Layout · Create serial (Resolve Alt-S): chain the nodes left to right, one undo step. */
export function chainNodes(at: GraphAt, ids: string[]): number {
  let made = 0;
  commit('Created serial chain', (d) => {
    const { graph: g, body } = graphAt(d, at);
    const ns = ids.map((id) => g.nodes.find((n) => n.id === id)!).filter(Boolean).sort((a, b) => a.position.x - b.position.x);
    for (let i = 0; i + 1 < ns.length; i++) {
      const out = firstOut(ns[i], body);
      const inp = out && inputFor(ns[i + 1], out.type, body);
      if (!out || !inp) continue;
      g.edges = g.edges.filter((e) => !(e.to.node === ns[i + 1].id && e.to.port === inp.key));
      g.edges.push({ id: newId<EdgeId>(), from: { node: ns[i].id, port: out.key }, to: { node: ns[i + 1].id, port: inp.key } });
      made++;
    }
  });
  return made;
}

/**
 * Layout · Create parallel (Resolve Alt-P): the selected nodes all branch off the input that
 * fed the first of them, and Mix nodes are inserted to merge the branches (the user states the
 * intent, the plumbing is built). Whatever the selection fed now hangs off the last Mix.
 */
export function branchParallel(at: GraphAt, ids: string[]): boolean {
  const mixDef = defOf('route.mix');
  if (!mixDef || ids.length < 2) return false;
  let ok = false;
  commit('Created parallel branches', (d) => {
    const { graph: g, body } = graphAt(d, at);
    const ns = ids.map((id) => g.nodes.find((n) => n.id === id)!).filter(Boolean).sort((a, b) => a.position.y - b.position.y);
    const firstIn = ports(ns[0], 'in', body)[0];
    const feed = firstIn && g.edges.find((e) => e.to.node === ns[0].id && e.to.port === firstIn.key)?.from;
    const sel = new Set(ns.map((n) => n.id));
    // Wires leaving the selection (e.g. the last one into Output) will hang off the final Mix.
    const downstream = g.edges.filter((e) => sel.has(e.from.node) && !sel.has(e.to.node));
    if (feed) {
      const feedNode = g.nodes.find((n) => n.id === feed.node)!;
      const feedType = portType(feedNode, feed.port, 'out', body)?.type ?? 'VideoFrame';
      for (const n of ns.slice(1)) {
        const inp = inputFor(n, feedType, body);
        if (!inp) continue;
        g.edges = g.edges.filter((e) => !(e.to.node === n.id && e.to.port === inp.key));
        g.edges.push({ id: newId<EdgeId>(), from: feed, to: { node: n.id, port: inp.key } });
      }
    }
    const right = Math.max(...ns.map((n) => n.position.x)) + 230;
    const midY = ns.reduce((a, n) => a + n.position.y, 0) / ns.length;
    let acc = ns[0];
    ns.slice(1).forEach((n, k) => {
      const mix: NodeInstance = { id: newId<NodeId>(), kind: mixDef.kind, defVersion: mixDef.defVersion, params: defaults(mixDef), bindings: {}, position: { x: right + k * 220, y: midY } };
      g.nodes.push(mix);
      const [a, b] = mixDef.inputs;
      g.edges.push({ id: newId<EdgeId>(), from: { node: acc.id, port: firstOut(acc, body)!.key }, to: { node: mix.id, port: a.key } });
      g.edges.push({ id: newId<EdgeId>(), from: { node: n.id, port: firstOut(n, body)!.key }, to: { node: mix.id, port: b.key } });
      acc = mix;
    });
    downstream.forEach((e) => (e.from = { node: acc.id, port: firstOut(acc, body)!.key }));
    ok = true;
  });
  return ok;
}

// ---------- containers (3.2 Phase 3): collapse and unpack ----------

/**
 * Collapse (3.5): the selected nodes of a block graph become one container, one undo step. Its ports
 * come from the wires crossing the selection; boundary wires keep their ids, so unpacking gives the
 * same graph back. One level only: there is no collapsing inside a container.
 */
export function collapseNodes(at: GraphAt, ids: string[], label = 'Group'): NodeId {
  if (typeof at !== 'string' && at.container) throw new MoshpitError('CONTAINER_NESTED', { why: 'a container holds no container' });
  const g = blockById(getDoc(), blockOf(at))?.graph;
  if (!g) throw new MoshpitError('PARAM_UNKNOWN', { blockId: blockOf(at) });
  const container = newId<NodeId>();
  const next = collapseSelection(g, ids as NodeId[], { container, groupIn: newId<NodeId>(), groupOut: newId<NodeId>(), edge: () => newId<EdgeId>() }, (n, port) => ports(n, 'out').find((p) => p.key === port)?.type);
  next.nodes.find((n) => n.id === container)!.label = label;
  commit(`Grouped ${ids.length} node${ids.length > 1 ? 's' : ''} into ${label}`, (d) => void (mutBlock(d, blockOf(at)).graph = next));
  return container;
}

/** The CT has six dials: a container exposes at most six macros (the engine's limit, shared with validateLook). */
export { MAX_MACROS };

const containerOf = (d: ProjectDoc, blockId: BlockId, id: NodeId) => {
  const c = mutBlock(d, blockId).graph.nodes.find((n) => n.id === id && n.kind === CONTAINER_KIND);
  if (!c?.body) throw new MoshpitError('PARAM_UNKNOWN', { container: id });
  return c as NodeInstance & { body: ContainerBody };
};

/**
 * 3.3: expose an inner node's numeric param as a macro on its container's face (and a CT dial). The
 * macro spans the param's whole range; until it is turned the param keeps its value. One undo step.
 */
export function exposeMacro(blockId: BlockId, container: NodeId, nodeId: NodeId, key: string): string {
  const c = containerOf(getDoc(), blockId, container);
  const inner = c.body.graph.nodes.find((n) => n.id === nodeId);
  const p = inner && defOf(inner.kind)?.params.find((x) => x.key === key);
  if (!inner || !p || (p.type !== 'float' && p.type !== 'int') || p.min === undefined || p.max === undefined) throw new MoshpitError('PARAM_UNKNOWN', { nodeId, key, why: 'only a number with a range can be a macro' });
  if (c.body.macros.some((m) => m.target.node === nodeId && m.target.param === key)) throw new MoshpitError('PARAM_UNKNOWN', { why: 'that param is already a macro' });
  if (c.body.macros.length >= MAX_MACROS) throw new MoshpitError('PARAM_UNKNOWN', { why: `a container has at most ${MAX_MACROS} macros (the CT's dials)` });
  let n = c.body.macros.length + 1;
  while (c.body.macros.some((m) => m.key === `macro${n}`)) n++;
  const mkey = `macro${n}`;
  commit(`Exposed ${p.label} as a macro of ${nodeLabel(c)}`, (d) => {
    containerOf(d, blockId, container).body.macros.push({ key: mkey as never, label: p.label, help: p.help, min: 0, max: 1, default: 0, target: { node: nodeId, param: key as never }, map: { from: p.min!, to: p.max!, curve: 'linear' } });
  });
  return mkey;
}

/** Remove a macro; where it was turned, its value stays on the param it drove, so nothing jumps. */
export function removeMacro(blockId: BlockId, container: NodeId, key: string) {
  const c = containerOf(getDoc(), blockId, container);
  const m = c.body.macros.find((x) => x.key === key);
  if (!m) return;
  commit(`Removed the ${m.label} macro`, (d) => {
    const box = containerOf(d, blockId, container);
    const raw = box.params[key];
    if (typeof raw === 'number') {
      const inner = box.body.graph.nodes.find((n) => n.id === m.target.node);
      const v = m.map ? mapValue((Math.min(m.max, Math.max(m.min, raw)) - m.min) / (m.max - m.min || 1), m.map) : raw;
      const int = inner && defOf(inner.kind)?.params.find((p) => p.key === m.target.param)?.type === 'int';
      if (inner) inner.params[m.target.param] = int ? Math.round(v) : v;
    }
    box.body.macros = box.body.macros.filter((x) => x.key !== key);
    delete box.params[key];
  });
}

export function renameContainer(blockId: BlockId, container: NodeId, label: string) {
  const name = label.trim().slice(0, 80);
  if (!name) return;
  commit(`Renamed a container → ${name}`, (d) => void (containerOf(d, blockId, container).label = name), `rename:${container}`);
}

// ---------- the look library (3.6, D1): your own looks, stamped as owned copies ----------

export const projectLooks = (d: ProjectDoc): ComponentDef[] => d.components?.looks ?? [];

/** A look name not yet in the library: `name`, or `name 2`, `name 3`… */
function freeName(d: ProjectDoc, name: string, except?: string): string {
  const taken = new Set(projectLooks(d).filter((l) => l.id !== except).map((l) => l.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n++;
  return `${name} ${n}`;
}

/**
 * Save a container as a look in this project's library; the container now links to it (origin).
 * Saving a container already linked to one of your looks overwrites that look (as Update master);
 * a new look under a name already taken gets the next free one ("VHS 2"), never a duplicate.
 */
export function saveLook(blockId: BlockId, container: NodeId, name?: string): ComponentId {
  const c = containerOf(getDoc(), blockId, container);
  const linked = masterOf(getDoc(), c);
  if (linked) {
    updateMaster(blockId, container);
    return linked.id;
  }
  const def = lookFrom(c, freeName(getDoc(), (name ?? nodeLabel(c)).trim().slice(0, 80) || 'Look'), { does: `Contains: ${c.body.graph.nodes.filter((n) => n.kind !== GROUP_IN_KIND && n.kind !== GROUP_OUT_KIND).map(nodeLabel).join(', ')}` });
  commit(`Saved ${def.name} as a look`, (d) => {
    (d.components ??= { looks: [] }).looks.push(def);
    containerOf(d, blockId, container).body.origin = { component: def.id, rev: def.rev };
  });
  return def.id;
}

/** Splice a placed node (a stamped look) into a block's chain: by its input, on the stream's run or before Output. */
function spliceInstance(g: Block['graph'], node: NodeInstance): boolean {
  const ins = ports(node, 'in'), outs = ports(node, 'out');
  if (!ins.length || !outs.length) return false;
  // A look that holds its own Decode (stream ops, the Decode, picture ops: most starter looks, which
  // applyRecipe groups that way) takes the block's Decode's place (D2), as applyRecipe does. Spliced
  // onto the stream run instead, it fed its picture output into the block's Decode: a type mismatch
  // and a second decode, and nothing rendered (bug hunt P1).
  if (node.body?.graph.nodes.some((n) => n.kind === DECODE_KIND)) {
    const dec = g.nodes.find((n) => n.kind === DECODE_KIND);
    if (!dec) return false;
    node.position = { ...dec.position };
    for (const e of g.edges) {
      if (e.to.node === dec.id) e.to = { node: node.id, port: ins[0].key };
      if (e.from.node === dec.id) e.from = { node: node.id, port: outs[0].key };
    }
    g.nodes = [...g.nodes.filter((n) => n.id !== dec.id), node];
    return true;
  }
  const e0 = findSplice(g, ins[0]?.type === 'EncodedVideoStream');
  if (!e0) return false;
  const at = g.nodes.find((n) => n.id === e0.to.node)!;
  for (const n of g.nodes) if (n.position.x >= at.position.x) n.position = { x: n.position.x + 220, y: n.position.y };
  node.position = { x: at.position.x, y: at.position.y };
  g.nodes.push(node);
  const e = g.edges.find((y) => y.id === e0.id)!;
  const fromType = portType(g.nodes.find((n) => n.id === e.from.node), e.from.port, 'out')?.type;
  const target = (fromType && ins.find((p) => compatible(fromType, p.type))) ?? ins[0];
  g.edges.push({ id: newId<EdgeId>(), from: e.from, to: { node: node.id, port: target.key } });
  e.from = { node: node.id, port: outs[0].key };
  return true;
}

/**
 * Place one of the project's looks into a block: a fresh owned copy, spliced into the chain. One undo
 * step. Null when the block has no chain to put it in; throws the compile error when it would not render.
 */
export function placeLook(blockId: BlockId, lookId: string, params?: Record<string, ParamValue>): NodeId | null {
  const def = projectLooks(getDoc()).find((l) => l.id === lookId);
  if (!def) throw new MoshpitError('PARAM_UNKNOWN', { look: lookId });
  const node = stampLook(def, { x: 300, y: 300 }, params);
  // Tried on a copy first: a block without a chain changes nothing (and leaves no history step), and
  // a placement that would not compile is refused with the compiler's own reason, before any commit.
  const trial = structuredClone(mutBlock(getDoc(), blockId).graph);
  if (!spliceInstance(trial, structuredClone(node))) return null;
  const plan = compileBlockGraph(blockId, trial);
  if (!plan.ok) throw plan.errors[0];
  commit(`Added ${def.name} to block`, (d) => void spliceInstance(mutBlock(d, blockId).graph, node));
  return node.id;
}

const masterOf = (d: ProjectDoc, c: NodeInstance) => projectLooks(d).find((l) => l.id === c.body?.origin?.component);

/** Rename one of your looks (a name already taken gets the next free one). One undo step. */
export function renameLook(lookId: string, name: string) {
  const look = projectLooks(getDoc()).find((l) => l.id === lookId);
  const clean = name.trim().slice(0, 80);
  if (!look || !clean || clean === look.name) return;
  const next = freeName(getDoc(), clean, lookId);
  commit(`Renamed the ${look.name} look → ${next}`, (d) => void (projectLooks(d).find((l) => l.id === lookId)!.name = next), `lookname:${lookId}`);
}

/**
 * Take one of your looks out of the library. Copies already placed are owned (D1): they stay, and
 * simply stop being linked to it. One undo step.
 */
export function removeLook(lookId: string) {
  const look = projectLooks(getDoc()).find((l) => l.id === lookId);
  if (!look) return;
  commit(`Removed the ${look.name} look from the library`, (d) => {
    d.components!.looks = d.components!.looks.filter((l) => l.id !== lookId);
    for (const b of d.timeline.blocks) for (const n of b.graph.nodes) if (n.body?.origin?.component === lookId) delete n.body.origin;
  });
}

/** Update master (D1, explicit): this container's insides become the library look's next revision. */
export function updateMaster(blockId: BlockId, container: NodeId) {
  const c = containerOf(getDoc(), blockId, container);
  const m = masterOf(getDoc(), c);
  if (!m) throw new MoshpitError('PARAM_UNKNOWN', { why: 'this container is not linked to a look in this project' });
  const next = lookFrom(c, m.name); // from the committed doc: a draft cannot be cloned
  commit(`Updated the ${m.name} look from this copy`, (d) => {
    const look = masterOf(d, c)!;
    look.body = next.body;
    look.params = next.params;
    look.rev += 1;
    containerOf(d, blockId, container).body.origin = { component: look.id, rev: look.rev };
  });
}

/** Update from master (D1, explicit): replace this copy's insides with the look's latest; turned macros keep their values. */
export function updateFromMaster(blockId: BlockId, container: NodeId) {
  const c = containerOf(getDoc(), blockId, container);
  const m = masterOf(getDoc(), c);
  if (!m) throw new MoshpitError('PARAM_UNKNOWN', { why: 'this container is not linked to a look in this project' });
  const fresh = stampLook(m, c.position);
  commit(`Updated this copy from the ${m.name} look`, (d) => {
    const box = containerOf(d, blockId, container);
    box.body = fresh.body!;
    for (const k of Object.keys(box.params)) if (!box.body.macros.some((x) => x.key === k)) delete box.params[k];
  });
}

/** Unpack (3.4): the container's nodes go back into the block graph for good, one undo step. */
export function unpackNodes(blockId: BlockId, container: NodeId) {
  const g = blockById(getDoc(), blockId)?.graph;
  const c = g?.nodes.find((n) => n.id === container);
  if (!g || !c) throw new MoshpitError('PARAM_UNKNOWN', { container });
  const next = unpackContainer(g, container);
  commit(`Unpacked ${nodeLabel(c)}`, (d) => void (mutBlock(d, blockId).graph = next));
}

/**
 * Mosh mode's "＋ Add effect" (and recipes): splice the node into the block's chain, wiring it
 * through. Where depends on the domain (B1): a Mosh op goes at the end of the encoded run that
 * starts at the Source (before the decode boundary); an image effect goes just before Output.
 */
/**
 * One-time repair on open (Waxy, 2026-10-08): ＋ Speed / Reverse (F1) could land AFTER a graph's
 * decode node, which compiles as GRAPH_DOMAIN_ORDER and renders nothing. A stream-only op found
 * after the decode boundary, on a plain one-in / one-out link, moves back to just before it.
 * Anything less simple is left for the graph's own error. Returns the labels it moved.
 */
export function repairStreamOrder(doc: ProjectDoc): { doc: ProjectDoc; moved: string[] } {
  const moved: string[] = [];
  const streamOnly = (kind: string) => { const d = defOf(kind); return !!d && d.domain === 'ENCODED_STREAM' && d.outputs.length > 0 && d.outputs.every((o) => o.type === 'EncodedVideoStream') && d.inputs.length === 1; };
  const out = structuredClone(doc);
  out.timeline.blocks.forEach((b, bi) => {
    const g = b.graph;
    const dec = g.nodes.find((n) => n.kind === 'decode.webcodecs');
    if (!dec) return;
    // Everything downstream of the decode node.
    const after = new Set<string>();
    const stack = [dec.id];
    while (stack.length) { const id = stack.pop()!; for (const e of g.edges) if (e.from.node === id && !after.has(e.to.node)) { after.add(e.to.node); stack.push(e.to.node); } }
    for (const n of g.nodes.filter((x) => after.has(x.id) && streamOnly(x.kind))) {
      const ins = g.edges.filter((e) => e.to.node === n.id), outs = g.edges.filter((e) => e.from.node === n.id);
      const intoDec = g.edges.filter((e) => e.to.node === dec.id);
      if (ins.length !== 1 || outs.length !== 1 || intoDec.length !== 1) continue;
      // Close the gap it leaves (its feeder now drives its consumer), then splice it in front of the
      // decode node: what fed decode feeds it, and it feeds decode. Three edges re-pointed, none lost.
      const [toN, fromN, toDec] = [ins[0], outs[0], intoDec[0]];
      fromN.from = { ...toN.from };
      toN.from = { ...toDec.from };
      toDec.from = { node: n.id, port: ports(n, 'out')[0].key };
      moved.push(`${nodeLabel(n)} in Block ${bi + 1}`);
    }
  });
  return { doc: moved.length ? out : doc, moved };
}

export const DECODE_KIND = 'decode.webcodecs';

/** The ports an edge joins, typed. */
function edgeTypes(g: Block['graph'], e: Block['graph']['edges'][number], body?: ContainerBody) {
  const fn = g.nodes.find((n) => n.id === e.from.node), tn = g.nodes.find((n) => n.id === e.to.node);
  return { from: portType(fn, e.from.port, 'out', body)?.type, to: portType(tn, e.to.port, 'in', body)?.type };
}

/**
 * Phase 1.1: draw the Decode where a graph decodes implicitly (an encoded output wired straight
 * into a picture input). Projects from before Phase 1.1 open with their boundary visible. It
 * changes no pixels and no freeze key (engine graph/decode.ts). A graph that decodes from two
 * different points is already an error (GRAPH_SECOND_DECODE) and is left as it is.
 */
export function ensureDecode(doc: ProjectDoc): ProjectDoc {
  const dec = defOf(DECODE_KIND);
  if (!dec) return doc;
  let out: ProjectDoc | null = null;
  doc.timeline.blocks.forEach((b, bi) => {
    if (b.graph.nodes.some((n) => n.kind === DECODE_KIND)) return;
    const implicit = b.graph.edges.filter((e) => { const t = edgeTypes(b.graph, e); return t.from === 'EncodedVideoStream' && t.to === 'VideoFrame'; });
    if (!implicit.length || new Set(implicit.map((e) => `${e.from.node}.${e.from.port}`)).size !== 1) return;
    out ??= structuredClone(doc);
    const g = out.timeline.blocks[bi].graph;
    const from = { ...implicit[0].from };
    const a = g.nodes.find((n) => n.id === from.node)!, z = g.nodes.find((n) => n.id === implicit[0].to.node)!;
    const node: NodeInstance = { id: newId<NodeId>(), kind: dec.kind, defVersion: dec.defVersion, params: defaults(dec), bindings: {}, position: { x: Math.round((a.position.x + z.position.x) / 2), y: a.position.y } };
    g.nodes.push(node);
    for (const e of g.edges) if (implicit.some((x) => x.id === e.id)) e.from = { node: node.id, port: dec.outputs[0].key as never };
    g.edges.push({ id: newId<EdgeId>(), from, to: { node: node.id, port: dec.inputs[0].key as never } });
  });
  return out ?? doc;
}

/**
 * The one-click fix for a second decode (Phase 1.1): wire the input from the block's Decode instead
 * of from the encoded stream. Draws a Decode first if the block has none. One undo step.
 * Hardening: it never throws. A block with no Decode whose implicit boundary is ambiguous (it
 * already decodes from two points, so ensureDecode draws nothing) changes nothing; the reason comes
 * back for the caller to say.
 */
export function feedFromDecode(blockId: BlockId, to: PortRef): { ok: true } | { ok: false; why: string } {
  const b = blockById(getDoc(), blockId);
  if (!b) return { ok: false, why: 'That block is gone.' };
  const graph = b.graph.nodes.some((n) => n.kind === DECODE_KIND) ? b.graph : ensureDecode({ ...getDoc(), timeline: { ...getDoc().timeline, blocks: [b] } }).timeline.blocks[0].graph;
  const dec = graph.nodes.find((n) => n.kind === DECODE_KIND);
  if (!dec) {
    const inLook = b.graph.nodes.find((n) => n.kind === CONTAINER_KIND && n.body?.graph.nodes.some((x) => x.kind === DECODE_KIND));
    if (inLook) return { ok: false, why: `This block's Decode is inside the ${nodeLabel(inLook)} look, so nothing outside it can take the decoded picture. Unpack the look (Ctrl+Shift+G) to wire from its Decode, or wire from the look's output.` };
    return { ok: false, why: 'This block has no single decode point to feed from: it already decodes from more than one place. Add a Decode after the last Mosh node and wire from it.' };
  }
  commit('Fed from Decode', (d) => {
    const blk = mutBlock(d, blockId);
    blk.graph = structuredClone(graph);
    blk.graph.edges = blk.graph.edges.filter((e) => !(e.to.node === to.node && e.to.port === to.port));
    blk.graph.edges.push({ id: newId<EdgeId>(), from: { node: dec.id, port: ports(dec, 'out')[0].key }, to: { ...to } });
  });
  return { ok: true };
}

/**
 * Phase 1.4: a Reroute on a wire (double-click it): the wire now runs through a pass-through you
 * can drag to tidy the layout. The picture or the stream kind, by the wire's type. One undo step.
 * Returns the new node's id, or null when the wire carries something without a Reroute.
 */
export function insertReroute(where: GraphAt, edgeId: EdgeId, at: { x: number; y: number }): NodeId | null {
  const scope = findGraph(getDoc(), where);
  const e = scope?.graph.edges.find((x) => x.id === edgeId);
  if (!scope || !e) return null;
  const t = edgeTypes(scope.graph, e, scope.body).from;
  const kind = t === 'EncodedVideoStream' ? 'route.reroute-stream' : t === 'VideoFrame' ? 'route.reroute' : null;
  const def = kind ? defOf(kind) : undefined;
  if (!def) return null;
  const node: NodeInstance = { id: newId<NodeId>(), kind: def.kind, defVersion: def.defVersion, params: defaults(def), bindings: {}, position: { x: Math.round(at.x), y: Math.round(at.y) } };
  commit('Added a Reroute on a wire', (d) => {
    const g = graphAt(d, where).graph;
    const w = g.edges.find((x) => x.id === edgeId)!;
    g.nodes.push(node);
    g.edges.push({ id: newId<EdgeId>(), from: { node: node.id, port: def.outputs[0].key as never }, to: { ...w.to } });
    w.to = { node: node.id, port: def.inputs[0].key as never };
  });
  return node.id;
}

/** Where an effect of this kind would be spliced into `g`: the edge it goes on, or null (no chain). */
/** Where something new goes in `g`'s chain: on the stream's run (`stream`) or just before Output. */
function findSplice(g: Block['graph'], stream: boolean) {
  const out = g.nodes.find((n) => defOf(n.kind)?.category === 'Output');
  let edge = out && g.edges.find((e) => e.to.node === out.id);
  if (stream) {
    // Walk from the Source along the encoded run; splice after its last node.
    let cur = g.nodes.find((n) => defOf(n.kind)?.category === 'Source');
    edge = undefined;
    for (let guard = 0; cur && guard < 100; guard++) {
      const next = g.edges.find((e) => e.from.node === cur!.id);
      if (!next) break;
      edge = next;
      const nn = g.nodes.find((n) => n.id === next.to.node);
      // Stay in the stream: the decode node is ENCODED_STREAM by its input but outputs frames, so the
      // walk stops before it. Going through it put Speed / Reverse (F1) after the decode boundary:
      // GRAPH_DOMAIN_ORDER, and nothing rendered (Waxy, 2026-10-08).
      // A container is on the run when its outputs are the stream (a Mosh-only look).
      const nd = nn && defOf(nn.kind);
      const outs = nn ? ports(nn, 'out') : [];
      const onRun = nn?.kind === CONTAINER_KIND || nd?.domain === 'ENCODED_STREAM';
      if (!onRun || !outs.length || outs.some((o) => o.type !== 'EncodedVideoStream')) break;
      cur = nn;
    }
  }
  return edge ?? null;
}

/** Splice a new node of `kind` into the chain of a mutable graph (a commit draft, or an audition copy). */
function spliceEffect(g: Block['graph'], kind: string, params?: Record<string, ParamValue>): boolean {
  const def = defOf(kind)!;
  const e0 = findSplice(g, def.domain === 'ENCODED_STREAM');
  if (!e0) return false;
  const at = g.nodes.find((n) => n.id === e0.to.node)!;
  const x = at.position.x;
  // Make room: everything from the splice point rightwards moves one column.
  for (const n of g.nodes) if (n.position.x >= x) n.position = { x: n.position.x + 220, y: n.position.y };
  const node: NodeInstance = { id: newId<NodeId>(), kind: def.kind, defVersion: def.defVersion, params: { ...defaults(def), ...params }, bindings: {}, position: { x, y: at.position.y } };
  g.nodes.push(node);
  const e = g.edges.find((y) => y.id === e0.id)!;
  const fromNode = g.nodes.find((n) => n.id === e.from.node);
  const fromType = portType(fromNode, e.from.port, 'out')?.type;
  const target = (fromType && def.inputs.find((p) => compatible(fromType, p.type))) ?? def.inputs[0];
  g.edges.push({ id: newId<EdgeId>(), from: e.from, to: { node: node.id, port: target.key } });
  e.from = { node: node.id, port: def.outputs[0].key };
  return true;
}

/** Append an effect to the block's chain (stream ops before the Decode, picture ops before Output); `params` over its starting values. */
export function appendEffect(blockId: BlockId, kind: string, params?: Record<string, ParamValue>) {
  const def = defOf(kind);
  if (!def) throw new MoshpitError('NODE_UNKNOWN_KIND', { kind });
  const b = blockById(getDoc(), blockId);
  if (!b) throw new MoshpitError('PARAM_UNKNOWN', { blockId });
  if (!findSplice(b.graph, def.domain === 'ENCODED_STREAM')) {
    addNode(blockId, kind, { x: 300, y: 300 });
    return;
  }
  commit(`Added ${def.label} to block`, (d) => void spliceEffect(mutBlock(d, blockId).graph, kind, params));
}

// Phase 2.2: an audition is the block's graph with the effects spliced in exactly as Add would, built
// on a copy: the project never changes. Memoised per (graph, kinds), so the new node ids are stable
// and the engine's trial slot is reused while the same audition plays.
const trials = new WeakMap<object, Map<string, Block['graph']>>();
const lookTrials = new WeakMap<object, WeakMap<ComponentDef, Map<string, Block['graph'] | null>>>();
export function trialGraph(block: Block, kinds: string[], params?: (Record<string, ParamValue> | undefined)[], look?: ComponentDef | null, lookParams?: Record<string, ParamValue>): Block['graph'] | null {
  // A missing/deleted saved look must never fall back to an invented linear chain.
  if (look === null) return null;
  if (look) {
    const byLook = lookTrials.get(block.graph) ?? new WeakMap<ComponentDef, Map<string, Block['graph'] | null>>();
    lookTrials.set(block.graph, byLook);
    const memo = byLook.get(look) ?? new Map<string, Block['graph'] | null>();
    byLook.set(look, memo);
    const key = JSON.stringify(lookParams ?? {});
    if (!memo.has(key)) {
      const graph = structuredClone(block.graph);
      const placed = spliceInstance(graph, stampLook(look, { x: 300, y: 300 }, lookParams));
      // A long knob gesture must not retain every intermediate graph for the session.
      if (memo.size >= 24) memo.delete(memo.keys().next().value!);
      memo.set(key, placed && compileBlockGraph(block.id, graph).ok ? graph : null);
    }
    return memo.get(key)!;
  }
  if (!kinds.length || kinds.some((k) => !defOf(k))) return null;
  const memo = trials.get(block.graph) ?? new Map<string, Block['graph']>();
  trials.set(block.graph, memo);
  const key = kinds.join('>') + (params ? JSON.stringify(params) : '');
  if (!memo.has(key)) {
    let ok = true;
    const g = produce(block.graph, (d) => { kinds.forEach((k, i) => { ok = spliceEffect(d as Block['graph'], k, params?.[i]) && ok; }); });
    if (!ok) return null; // a block without a chain (no Output): nothing to audition on
    if (memo.size >= 48) memo.delete(memo.keys().next().value!);
    memo.set(key, g);
  }
  return memo.get(key)!;
}

/** Install the exact audition graph as one edit, refusing to replace a block edited since staging. */
export function applyTrialGraph(base: Block, graph: BlockGraph, label: string): boolean {
  const doc = getDoc();
  if (blockById(doc, base.id) !== base || activeBlock(doc)?.id !== base.id || isFrozen(doc, { kind: 'block', blockId: base.id })) return false;
  const plan = compileBlockGraph(base.id, graph);
  if (!plan.ok) throw plan.errors[0];
  commit(label, (d) => { mutBlock(d, base.id).graph = graph; });
  return true;
}

export function setBypass(at: GraphAt, nodeId: NodeId, bypass: boolean) {
  commit(bypass ? 'Bypassed node' : 'Enabled node', (d) => {
    mutNode(d, at, nodeId).bypass = bypass;
  });
}

// ---------- blocks ----------

export function setBlock(blockId: BlockId, patch: Partial<Pick<Block, 'repeat' | 'in' | 'out' | 'kind'>> & { mute?: boolean; mirror?: number }, label: string) {
  if (patch.kind && !firstStaysPicture(getDoc().timeline.blocks.map((x) => (x.id === blockId ? { ...x, kind: patch.kind! } : x)))) return;
  commit(label, (d) => {
    const b = mutBlock(d, blockId);
    const { mute, mirror, ...rest } = patch;
    Object.assign(b, rest);
    if (mute !== undefined) b.audio.mute = mute;
    if (mirror !== undefined) b.audio.mirror = mirror;
  }, `blk:${blockId}:${Object.keys(patch).join()}`);
}

/**
 * F1 (UX round 2): trim a block already on the arrangement. IN / OUT move inside its clip's conform
 * (the slice it came from), clamped so IN < OUT; a drag is one undo step (one key per block). To
 * reach past the slice, re-slice the clip in Source.
 */
export function trimBlock(blockId: BlockId, patch: { in?: number; out?: number }) {
  const d = getDoc();
  const b = blockById(d, blockId);
  if (!b) return;
  const frames = d.resources.conforms.find((c) => c.sourceId === b.sourceId)?.frames ?? b.out;
  const out = Math.min(frames, Math.max((patch.in === undefined ? b.in : 0) + 1, Math.round(patch.out ?? b.out)));
  const inF = Math.max(0, Math.min(out - 1, Math.round(patch.in ?? b.in)));
  if (inF === b.in && out === b.out) return;
  commit(`Trimmed Block ${d.timeline.blocks.indexOf(b) + 1} → ${inF}–${out}`, (doc) => Object.assign(mutBlock(doc, blockId), { in: inF, out }), `trim:${blockId}`);
}

/** The project's export settings (L13: export config lives in the project file). */
export function setExportConfig(patch: Partial<ProjectDoc['exportConfig']>, label: string) {
  commit(label, (d) => {
    Object.assign(d.exportConfig, patch);
  }, `export:${Object.keys(patch).join()}`);
}

/** A slice onto the end of the edit timeline. Block 0 is always picture (a mosh needs a picture). */
/**
 * The timeline's first block must be a picture block: a motion block has no picture of its own to
 * move (TIMELINE_NO_PICTURE: the preview and the render stop). Every command that could put a motion
 * block first checks here and is refused, with the reason (bug hunt P1: moveBlock had no guard).
 */
function firstStaysPicture(blocks: Block[]): boolean {
  if (blocks[0]?.kind !== 'motion') return true;
  toast('The first block has to be a picture block: a motion block has no picture of its own to move. Put a picture block first.', { kind: 'warn' });
  return false;
}

export function addBlock(sourceId: SourceId, inF: number, outF: number, kind?: Block['kind']): BlockId {
  const src = sourceById(getDoc(), sourceId);
  // The first block on an empty timeline is a picture block, even when asked for as motion (said why).
  if (kind === 'motion' && !getDoc().timeline.blocks.length) {
    toast('Added as a picture block: the first block has to be one (a motion block has no picture of its own to move).', { kind: 'warn' });
    kind = 'picture';
  }
  if (!src) throw new MoshpitError('MEDIA_FILE_MISSING', { sourceId });
  // The source-range contract (P0): a block is [in, out) on its clip's conform, explicit, IN < OUT,
  // and inside the clip. It never stands for "the whole file" by default.
  const conf = getDoc().resources.conforms.find((c) => c.sourceId === sourceId);
  if (!Number.isInteger(inF) || !Number.isInteger(outF) || inF < 0 || outF <= inF || (conf?.frames && outF > conf.frames)) {
    throw new MoshpitError('BLOCK_RANGE_INVALID', { in: inF, out: outF, frames: conf?.frames });
  }
  const k = kind ?? (getDoc().timeline.blocks.length ? 'motion' : 'picture');
  const out = defOf('output.sink');
  const clip = defOf('source.clip');
  if (!out || !clip) throw new MoshpitError('NODE_UNKNOWN_KIND', { kind: 'source.clip/output.sink' });
  const s: NodeInstance = { id: newId<NodeId>(), kind: clip.kind, defVersion: clip.defVersion, params: defaults(clip), bindings: {}, position: { x: 0, y: 120 } };
  const o: NodeInstance = { id: newId<NodeId>(), kind: out.kind, defVersion: out.defVersion, params: defaults(out), bindings: {}, position: { x: 460, y: 120 } };
  // Phase 1.1: Source → Decode → Output, so the encoded / picture boundary is drawn from the start.
  const dec = defOf(DECODE_KIND);
  const mid: NodeInstance[] = dec ? [{ id: newId<NodeId>(), kind: dec.kind, defVersion: dec.defVersion, params: defaults(dec), bindings: {}, position: { x: 230, y: 120 } }] : [];
  const chain = [s, ...mid, o];
  const id = newId<BlockId>();
  commit(`Added ${k} block from ${src.name}`, (d) => {
    d.timeline.blocks.push({
      id, kind: k, sourceId, in: inF, out: outF, repeat: 1, seam: { kind: 'seam.mosh', defVersion: 1, keepInnerKeyframes: false },
      graph: { nodes: chain, edges: chain.slice(1).map((n, i) => ({ id: newId<EdgeId>(), from: { node: chain[i].id, port: defOf(chain[i].kind)!.outputs[0].key }, to: { node: n.id, port: defOf(n.kind)!.inputs[0].key } })) },
      audio: { mute: false }, refs: [],
    });
    d.view.activeBlock = id;
  });
  return id;
}

export function removeBlock(id: BlockId) {
  if (!blockById(getDoc(), id)) return;
  if (!firstStaysPicture(getDoc().timeline.blocks.filter((x) => x.id !== id))) return;
  commit('Deleted block', (d) => {
    d.timeline.blocks = d.timeline.blocks.filter((x) => x.id !== id);
    d.freezes = d.freezes.filter((f) => f.target.blockId !== id);
    if (d.view.activeBlock === id) d.view.activeBlock = d.timeline.blocks[0]?.id;
  });
}

/** A copy of the block right after it: same range and kind, its graph with fresh node and edge ids. */
export function duplicateBlock(id: BlockId): BlockId | undefined {
  const b = blockById(getDoc(), id);
  if (!b) return;
  const nid = new Map(b.graph.nodes.map((n) => [n.id, newId<NodeId>()] as const));
  const copy: Block = {
    ...structuredClone(b),
    id: newId<BlockId>(),
    graph: {
      nodes: b.graph.nodes.map((n) => ({ ...structuredClone(n), id: nid.get(n.id)! })),
      edges: b.graph.edges.map((e) => ({ ...structuredClone(e), id: newId<EdgeId>(), from: { ...e.from, node: nid.get(e.from.node)! }, to: { ...e.to, node: nid.get(e.to.node)! } })),
    },
  };
  commit('Duplicated block', (d) => {
    d.timeline.blocks.splice(d.timeline.blocks.findIndex((x) => x.id === id) + 1, 0, copy);
    d.view.activeBlock = copy.id;
  });
  return copy.id;
}

/** Take a clip out of the project, with its conform. Refused while a block still plays it. */
export function removeSource(id: SourceId): boolean {
  const d = getDoc();
  if (d.timeline.blocks.some((b) => b.sourceId === id || b.refs.includes(id))) return false;
  const src = sourceById(d, id);
  commit(`Removed ${src?.name ?? 'clip'} from the project`, (x) => {
    x.resources.sources = x.resources.sources.filter((s) => s.id !== id);
    x.resources.conforms = x.resources.conforms.filter((c) => c.sourceId !== id);
  });
  return true;
}

export function moveBlock(from: number, to: number): boolean {
  const order = [...getDoc().timeline.blocks];
  const [b] = order.splice(from, 1);
  order.splice(to, 0, b);
  if (!firstStaysPicture(order)) return false;
  commit('Reordered blocks', (d) => {
    const [x] = d.timeline.blocks.splice(from, 1);
    d.timeline.blocks.splice(to, 0, x);
  });
  return true;
}

// ---------- freeze (L25) ----------

export const isFrozen = (d: ProjectDoc, t: FreezeTarget) =>
  d.freezes.some((f) => f.target.kind === t.kind && f.target.blockId === t.blockId && (t.kind === 'block' || (f.target.kind === 'node' && f.target.nodeId === t.nodeId)));

const pendingFreezes = new Map<string, Promise<boolean>>();
export async function toggleFreeze(t: FreezeTarget, range: [number, number]) {
  if (isFrozen(getDoc(), t)) {
    commit('Unfroze', (d) => {
      d.freezes = d.freezes.filter((f) => !(f.target.kind === t.kind && f.target.blockId === t.blockId && (t.kind === 'block' || (f.target.kind === 'node' && f.target.nodeId === t.nodeId))));
    });
    return false;
  }
  const origin = getDoc(), session = getProjectSession();
  const key = `${session}:${t.kind}:${t.blockId}:${t.kind === 'node' ? t.nodeId : ''}`;
  const pending = pendingFreezes.get(key);
  if (pending) return pending;
  const block = blockById(origin, t.blockId);
  const stillCurrent = () => {
    const now = getDoc();
    return session === getProjectSession() && now.id === origin.id && !!block &&
      now.timeline === origin.timeline && now.settings === origin.settings && now.modulators === origin.modulators;
  };
  const check = () => { if (!stillCurrent()) throw new DOMException('Freeze superseded by a project or timeline change', 'AbortError'); };
  const work = (async () => {
    check();
    // A freeze renders from the master. Removing its old source (e.g. New/Open) also ends
    // this wait, so ownership must be checked before dispatch as well as on completion.
    try { await waitForMasters([block!.sourceId]); }
    catch (error) { check(); throw error; }
    check();
    const rec = await engine.freeze(t, range).promise;
    check();
    commit(t.kind === 'block' ? 'Froze block' : 'Froze node', (d) => { d.freezes.push(rec); });
    return true;
  })();
  pendingFreezes.set(key, work);
  try { return await work; }
  finally { if (pendingFreezes.get(key) === work) pendingFreezes.delete(key); }
}

// ---------- LFOs (L8) and bindings (L7) ----------

export function setLfo(id: LfoId, patch: Partial<Lfo>, label: string) {
  commit(label, (d) => {
    Object.assign(d.modulators.lfos.find((l) => l.id === id)!, patch);
  }, `lfo:${id}:${Object.keys(patch).join()}`);
}

export function addLfo() {
  commit('Added LFO', (d) => {
    d.modulators.lfos.push({ id: newId<LfoId>(), label: `LFO ${d.modulators.lfos.length + 1}`, shape: 'sine', period: 8, unit: 'beats', phase: 0 });
  });
}

export function linkParam(lfoId: LfoId, at: GraphAt, nodeId: NodeId, key: string, depth = 0.5) {
  commit('Linked LFO', (d) => {
    const n = mutNode(d, at, nodeId);
    n.bindings[key] = { ...n.bindings[key], lfo: { lfoId, depth, op: 'add' } };
  });
}

export function setLinkDepth(at: GraphAt, nodeId: NodeId, key: string, depth: number) {
  commit(`LFO depth → ${depth.toFixed(2)}`, (d) => {
    const lfo = mutNode(d, at, nodeId).bindings[key]?.lfo;
    if (lfo) lfo.depth = depth;
  }, `depth:${nodeId}:${key}`);
}

export function unlinkParam(at: GraphAt, nodeId: NodeId, key: string) {
  commit('Unlinked LFO', (d) => {
    const n = mutNode(d, at, nodeId);
    const { lfo: _drop, ...rest } = n.bindings[key] ?? ({} as ParamBinding);
    if (Object.keys(rest).length) n.bindings[key] = rest;
    else delete n.bindings[key];
  });
}

export interface LfoLink {
  lfoId: LfoId;
  block: Block;
  blockIndex: number;
  node: NodeInstance;
  key: string;
  depth: number;
}

export function lfoLinks(d: ProjectDoc): LfoLink[] {
  const out: LfoLink[] = [];
  d.timeline.blocks.forEach((block, blockIndex) =>
    nodesOf(block).forEach((node) =>
      Object.entries(node.bindings).forEach(([key, b]) => {
        if (b.lfo) out.push({ lfoId: b.lfo.lfoId, block, blockIndex, node, key, depth: b.lfo.depth });
      }),
    ),
  );
  return out;
}

// ---------- Values (Phase 1.5): named project knobs that drive params through a Map-Range ----------

export function addValue(): ValueId {
  const id = newId<ValueId>();
  commit('Added a Value', (d) => {
    const vs = (d.modulators.values ??= []);
    vs.push({ id, label: `VALUE ${vs.length + 1}`, value: 0.5 });
  });
  return id;
}

export function setValue(id: ValueId, patch: Partial<Pick<ProjectValue, 'label' | 'value'>>, label: string) {
  commit(label, (d) => {
    const v = d.modulators.values?.find((x) => x.id === id);
    if (v) Object.assign(v, patch);
  }, `value:${id}:${Object.keys(patch).join()}`);
}

export function removeValue(id: ValueId) {
  commit('Removed a Value', (d) => {
    d.modulators.values = (d.modulators.values ?? []).filter((v) => v.id !== id);
    for (const b of d.timeline.blocks) for (const n of nodesOf(b)) for (const [k, bd] of Object.entries(n.bindings)) if (bd.value?.valueId === id) clearBinding(n, k, 'value');
  });
}

/** Link a param to a Value: by default the Value's 0..1 spans the param's whole range, linearly. */
export function linkValue(valueId: ValueId, at: GraphAt, nodeId: NodeId, key: string) {
  commit('Linked a Value', (d) => {
    const n = mutNode(d, at, nodeId);
    const p = defOf(n.kind)?.params.find((x) => x.key === key);
    n.bindings[key] = { ...n.bindings[key], value: { valueId, from: p?.min ?? 0, to: p?.max ?? 1, curve: 'linear' } };
  });
}

export function setValueLink(at: GraphAt, nodeId: NodeId, key: string, patch: Partial<Pick<ValueLink, 'from' | 'to' | 'curve'>>) {
  commit(`Value range → ${Object.entries(patch).map(([k, v]) => `${k} ${typeof v === 'number' ? +v.toFixed(3) : v}`).join(', ')}`, (d) => {
    const v = mutNode(d, at, nodeId).bindings[key]?.value;
    if (v) Object.assign(v, patch);
  }, `vlink:${nodeId}:${key}:${Object.keys(patch).join()}`);
}

export function unlinkValue(at: GraphAt, nodeId: NodeId, key: string) {
  commit('Unlinked a Value', (d) => clearBinding(mutNode(d, at, nodeId), key, 'value'));
}

function clearBinding(n: NodeInstance, key: string, which: keyof ParamBinding) {
  const { [which]: _drop, ...rest } = n.bindings[key] ?? ({} as ParamBinding);
  if (Object.keys(rest).length) n.bindings[key] = rest;
  else delete n.bindings[key];
}

export interface ValueLinkRef { valueId: ValueId; block: Block; blockIndex: number; node: NodeInstance; key: string; link: ValueLink }

export function valueLinks(d: ProjectDoc): ValueLinkRef[] {
  const out: ValueLinkRef[] = [];
  d.timeline.blocks.forEach((block, blockIndex) =>
    nodesOf(block).forEach((node) =>
      Object.entries(node.bindings).forEach(([key, b]) => {
        if (b.value) out.push({ valueId: b.value.valueId, block, blockIndex, node, key, link: b.value });
      }),
    ),
  );
  return out;
}

// ---------- sources, marks, chapters ----------

export type ImportFormat = Pick<ProjectDoc['settings'], 'fps' | 'working'>;

/** Import completion can race Undo/Redo even while ordinary format controls are locked. */
export function canAdoptImport(format: ImportFormat, conform: ConformedSource): boolean {
  const current = getDoc().settings;
  const sameRate = (a: ImportFormat['fps'], b: ImportFormat['fps']) => a.num * b.den === b.num * a.den;
  if (sameRate(current.fps, format.fps) && current.working.w === format.working.w && current.working.h === format.working.h &&
    sameRate(conform.fps, format.fps) && conform.width === format.working.w && conform.height === format.working.h) return true;
  toast('Import stopped because its prepared format no longer matches the project. Import the clip again at the current frame rate and working size. Your project was kept unchanged.', { kind: 'warn' });
  return false;
}

/** An imported clip: the source and its conform record (L29) travel together, pinned (D7). */
export function addSource(src: SourceClip, conform?: ConformedSource) {
  commit(`Imported ${src.name}`, (d) => {
    if (!d.resources.sources.some((s) => s.id === src.id)) d.resources.sources.push({ ...src, conformId: conform?.id ?? src.conformId });
    if (conform && !d.resources.conforms.some((c) => c.id === conform.id)) d.resources.conforms.push(conform);
  });
}

/**
 * Proxy-first import: the master for a clip is ready, so its ready record replaces the proxy-stage
 * one (same id). It is a fact about the media, not an edit — so no undo step, and every snapshot
 * in the history gets it too: undoing past this moment must not bring the 'proxy' record back.
 */
export function adoptConform(conform: ConformedSource) {
  const swap = (d: ProjectDoc): ProjectDoc => {
    const i = d.resources.conforms.findIndex((c) => c.id === conform.id);
    if (i < 0 || d.resources.conforms[i] === conform) return d;
    const conforms = [...d.resources.conforms];
    conforms[i] = conform;
    return { ...d, resources: { ...d.resources, conforms } };
  };
  projectStore.set((s) => {
    const doc = swap(s.doc);
    const history = (entries: HistoryEntry[]) => {
      const updated = entries.map(e => {
        const before = swap(e.before);
        return before === e.before ? e : { ...e, before };
      });
      return updated.every((e, i) => e === entries[i]) ? entries : updated;
    };
    // An undone import may exist only in redo history when its master completes.
    const past = history(s.past), future = history(s.future);
    if (doc === s.doc && past === s.past && future === s.future) return s;
    if (doc !== s.doc) engine.updateProject(doc);
    return { ...s, doc, past, future };
  });
}

/** Sources whose conform is still the proxy (its master encodes in the background). */
export function mastersPending(d: ProjectDoc, sourceIds?: SourceId[]): SourceId[] {
  return d.resources.sources
    .filter((s) => (!sourceIds || sourceIds.includes(s.id)) && d.resources.conforms.find((c) => c.id === s.conformId)?.status === 'proxy')
    .map((s) => s.id);
}

/** Resolves once none of these sources is waiting on its master (at once if none is). */
export function waitForMasters(sourceIds: SourceId[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let offProject = () => {};
    let offMaster = () => {};
    const finish = (error?: unknown, failed = false) => {
      if (settled) return;
      settled = true;
      offProject();
      offMaster();
      if (failed) reject(error); else resolve();
    };
    const check = () => {
      const pending = mastersPending(getDoc(), sourceIds);
      if (!pending.length) finish();
    };
    offProject = projectStore.subscribe(check);
    offMaster = engine.onConformUpdate?.((u) => {
      if (sourceIds.includes(u.sourceId) && u.state === 'FAILED' && mastersPending(getDoc(), [u.sourceId]).length) {
        finish(u.error ?? { code: 'CONFORM_FAILED', context: { sourceId: u.sourceId } }, true);
      }
    }) ?? (() => {});
    check();
    void engine.conformStates?.().then((states) => {
      if (settled) return;
      const failed = states.find((u) => sourceIds.includes(u.sourceId) && u.state === 'FAILED' && mastersPending(getDoc(), [u.sourceId]).length);
      if (failed) finish(failed.error ?? { code: 'CONFORM_FAILED', context: { sourceId: failed.sourceId } }, true);
      else check();
    }, (error) => finish(error, true));
  });
}

export function setMarks(sourceId: SourceId, inF: number, outF: number) {
  if (!(outF > inF) || inF < 0) return; // IN must precede OUT: an invalid range is never stored
  commit('Set IN/OUT', (d) => {
    const s = sourceById(d, sourceId)!;
    if (s.marks[0]) Object.assign(s.marks[0], { in: inF, out: outF });
    else s.marks.push({ id: newId(), in: inF, out: outF });
  }, `marks:${sourceId}`);
}

export function setChapters(sourceId: SourceId, chapters: Chapter[], label: string) {
  commit(label, (d) => {
    sourceById(d, sourceId)!.chapters = chapters;
  });
}

export function setSettings(patch: Partial<ProjectDoc['settings']>, label: string) {
  commit(label, (d) => {
    Object.assign(d.settings, patch);
  }, `settings:${Object.keys(patch).join()}`);
}

/** Project frame rates offered wherever the rate is picked (Settings, the Render form). */
export const FPS_OPTIONS: ProjectDoc['settings']['fps'][] = [
  { num: 24000, den: 1001 }, { num: 24, den: 1 }, { num: 25, den: 1 }, { num: 30000, den: 1001 }, { num: 30, den: 1 },
  { num: 50, den: 1 }, { num: 60000, den: 1001 }, { num: 60, den: 1 },
];

/** Pinned conforms cannot be converted by changing settings or reopening the project. */
export async function changeProjectFormat(label: string, patch: Partial<ProjectDoc['settings']>): Promise<boolean> {
  const doc = getDoc(), effective = { ...patch };
  // Equivalent rationals describe the same clock; don't add a spurious undo step.
  if (effective.fps && effective.fps.num * doc.settings.fps.den === doc.settings.fps.num * effective.fps.den) delete effective.fps;
  if (effective.working && effective.working.w === doc.settings.working.w && effective.working.h === doc.settings.working.h) delete effective.working;
  if (!Object.keys(effective).length) return true;
  if ((effective.fps || effective.working) && Object.values(jobStore.get()).some(job => job.kind === 'import' && job.task)) {
    toast('Wait for the current imports to finish or cancel them before changing the project format.', { kind: 'warn' });
    return false;
  }
  if ((effective.fps || effective.working) && (doc.resources.sources.length || doc.resources.conforms.length)) {
    toast('Frame rate and working size are fixed after importing media. Start a new project and set its format before importing. Export resolution can still be changed in OUT.', { kind: 'warn' });
    return false;
  }
  commit(label, d => {
    // Only the matching default follows working size; a deliberately different export stays put.
    if (effective.working && d.exportConfig.width === d.settings.working.w && d.exportConfig.height === d.settings.working.h) {
      d.exportConfig.width = effective.working.w;
      d.exportConfig.height = effective.working.h;
    }
    Object.assign(d.settings, effective);
  });
  return true;
}
