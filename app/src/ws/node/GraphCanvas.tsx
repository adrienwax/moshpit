// The node canvas: React Flow as an editor only (L24). Nodes and wires are projections of the
// active block's graph in the project store; every change dispatches a store command. Project
// LFOs appear as dashed "project" ghosts wired (gold, Scalar) to the params they drive.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BackgroundVariant, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges,
  useReactFlow, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type OnConnectEnd, type OnConnectStart,
} from '@xyflow/react';
import type { Block, BlockGraph, BlockId, ContainerBody, EdgeType, NodeDef, NodeInstance, PortDef } from '@moshpit/engine';
import { CONTAINER_KIND } from '@moshpit/engine';
import { defOf } from '../../engine';
import { CATS, DOMAIN_SHORT, edgeStyle } from '../../lib/cats';
import { organise } from '../../lib/graphLayout';
import { fmtBeats } from '../../lib/time';
import {
  addNode, branchParallel, chainNodes, connect, connectionError, feedFromDecode, insertReroute, type PortRef, isFrozen, moveNodes, removeEdges, removeNodes, selectNode, setBlockPanZoom, toggleViewer, transact, undoAction, useProject,
  ports, paramsOf, collapseNodes, unpackNodes, getDoc, type GraphAt,
} from '../../state/project';
import { openContainer, useUi } from '../../state/ui';
import { NODE_FREEZE, NODE_FREEZE_PLANNED, freezeNode, nodeLabel, useActive, NodeParam, blockName } from '../../components/nodes';
import { choose, toast, toastError, Empty } from '../../qol/qol';
import { openRadial } from '../../radial/Radial';
import { Icon } from '../../components/Icon';
import { addRing, rootRing, searchAll, type NodeMenuCtx } from './nodeRadial';
import { applyRecipe } from '../../state/recipes';
import { createStore, useSticky, useStore } from '../../state/store';
import { CanvasGestures } from './CanvasGestures';
import { blocksShortcutTarget } from '../../lib/keyboard';
import { MpNodeFace } from '../../../../shared/ui/MpNodeFace';
import { resolveNodePresentation, type RegistrySnapshot, type PortDescriptor } from '../../../../shared/graph/registry';
import registrySnapshot from '../../../../shared/graph/registry.json';

// ---------- bridge: lets the library (outside React Flow) add nodes at the canvas ----------

interface CanvasBridge {
  at: GraphAt;
  /** Flow position under a screen point, or null when the point is not over the canvas. */
  flowAt(x: number, y: number): { x: number; y: number } | null;
  center(): { x: number; y: number };
}
export const canvasBridge = createStore<CanvasBridge | null>(null);

// ---------- node rendering ----------

/** `at` is the graph the node sits in; `body` the container it is inside (its Group nodes' ports come from it). */
export type NData = { block: Block; at: GraphAt; body?: ContainerBody; node: NodeInstance; def?: NodeDef; frozen: boolean; viewed: boolean };

const scopeKey = (at: GraphAt) => (typeof at === 'string' ? at : `${at.blockId}/${at.container ?? ''}`);
/** A project modulator's ghost: an LFO (period) or, Phase 1.5, a Value (its 0..1). */
type LData = { label: string; period: string; kind?: 'LFO' | 'VALUE' };

/**
 * Framing the graph: fit everything, but never zoom in past 0.8× — a three-node chain stays a
 * modest cluster with room around it (Blender, Fusion and TouchDesigner open the same way)
 * instead of filling the canvas at 2.5×. A big graph still fits whole, down to minZoom.
 */
const FIT = { padding: 0.25, maxZoom: 0.8 };


/**
 * Phase 1.2: the wire being dragged (its fixed end). While it is set, every socket on the canvas
 * says whether it would accept the wire: the same check a drop runs (connectionError, cached).
 */
const wireDrag = createStore<{ key: string; node: string; port: string; from: 'source' | 'target' } | null>(null);

function useWireVerdict(at: GraphAt, node: string, port: string, kind: 'target' | 'source'): 'can' | 'cannot' | null {
  const w = useStore(wireDrag, (s) => s);
  if (!w || w.key !== scopeKey(at)) return null;
  if (w.node === node && w.port === port) return null; // the socket the wire starts from
  if (w.from === kind) return 'cannot'; // an output never takes an output
  const err = w.from === 'source'
    ? connectionError(at, { node: w.node as never, port: w.port as never }, { node: node as never, port: port as never })
    : connectionError(at, { node: node as never, port: port as never }, { node: w.node as never, port: w.port as never });
  return err ? 'cannot' : 'can';
}

function PortHandle({ p, kind, at, nodeId, face, readOnly = false }: { p: PortDescriptor; kind: 'target' | 'source'; at: GraphAt; nodeId: string; face: React.ReactNode; readOnly?: boolean }) {
  const s = edgeStyle(p.type as EdgeType, p.subtype) ?? {stroke:'var(--txt-3)',label:p.type,domain:'ctl'};
  const verdict = useWireVerdict(at, nodeId, p.key, kind);
  return (
    <Handle
      type={kind}
      id={p.key}
      position={kind === 'target' ? Position.Left : Position.Right}
      className={`port mp-port-handle ptype-${p.type} dom-${s.domain}${p.type === 'Field' ? ' ring' : ''}${verdict ? ' ' + verdict : ''}`}
      style={{ '--pc': s.stroke } as React.CSSProperties}
      title={`${p.label} · ${s.label} (${DOMAIN_SHORT[p.type as EdgeType]})${p.cardinality === 'optional-one' ? ' (optional)' : ''}${p.help ? ' — ' + p.help : ''}`}
     isConnectable={!readOnly && p.available !== false} data-port-available={p.available !== false}>{face}</Handle>
  );
}

export const MpNode = memo(function MpNode({ data, selected }: NodeProps<Node<NData>>) {
  const { block, at, body, node, def, frozen, viewed } = data;
  const model = resolveNodePresentation(registrySnapshot as RegistrySnapshot, node, { body });
  const specs = paramsOf(node);
  const container = node.kind === CONTAINER_KIND;
  return <MpNodeFace model={model} mode="edit" selected={!!selected} frozen={frozen} viewed={viewed} bypassed={!!node.bypass}
    renderPort={(p, direction, face) => <PortHandle p={p} kind={direction === 'in' ? 'target' : 'source'} at={at} nodeId={node.id} face={face} readOnly={model.readOnly} />}
    renderParameter={key => { const p = specs.find(p => p.key === key); return p ? <NodeParam block={block} node={node} p={p} variant="mini" /> : null; }}
    headerActions={def?.freezable && !container ? <button className={'freezebtn nodrag'+(frozen?' on':'')} disabled={!NODE_FREEZE}
      title={NODE_FREEZE ? 'Freeze / re-render this node to a cached render (L25)' : NODE_FREEZE_PLANNED}
      onClick={e => (e.stopPropagation(), freezeNode(block,node))} aria-label="Freeze node"><Icon name="freeze" size={14} /></button> : undefined}
    viewerAction={<button className={'viewdot nodrag'+(viewed?' on':'')} title="Viewer — show this node output"
      onClick={e => (e.stopPropagation(), toggleViewer(block.id,node.id))}>◉</button>}
    attachment={!container ? <Handle type="target" id="__mod" position={Position.Top} className="modhandle" isConnectable={false} /> : undefined}
    containerHint={container ? <><div className="pf ctrhint">double-click to open · Ctrl+Shift+G unpacks</div></> : undefined} />;
});

/** Whether the graph canvas has keyboard focus (the last pointer press landed in it). */
let canvasFocus = false;

const LfoGhost = memo(function LfoGhost({ data }: NodeProps<Node<LData>>) {
  const v = data.kind === 'VALUE';
  return (
    <div className="gnode rf project lfoghost" style={{ borderLeftColor: 'var(--dom-ctl)' }} title={v ? 'Project Value: one knob driving every param linked to it, each through its own range (Project LFOs pane)' : 'Project-scope LFO: not owned by this block; its phase is continuous across every block'}>
      <span className="projbadge">project</span>
      <div className="gt" style={{ background: 'linear-gradient(90deg, color-mix(in srgb, var(--dom-ctl) 16%, transparent), transparent)' }}>
        <span className="cbadge" style={{ color: 'var(--gold)', borderColor: 'var(--gold)' }}>{v ? '◆' : '∿'}</span>
        <span className="gname">{data.label}</span>
        <span className="cattag" style={{ color: 'var(--gold)' }}>{v ? 'VALUE' : 'LFO'}</span>
      </div>
      <div className="gb"><div className="pf"><span>{v ? 'value' : 'period'}</span><span className="pv musval">{data.period}</span></div></div>
      <Handle type="source" id="out" position={Position.Right} className="port dom-ctl" style={{ top: 38, '--pc': 'var(--gold)' } as React.CSSProperties} isConnectable={false} />
    </div>
  );
});

const nodeTypes = { mp: MpNode, lfo: LfoGhost };

// ---------- projection ----------

function portOf(n: NodeInstance | undefined, key: string, dir: 'in' | 'out', body?: ContainerBody) {
  return n ? ports(n, dir, body).find((p) => p.key === key) : undefined;
}

function buildEdges(graph: BlockGraph, lfoEdges: Edge[], body?: ContainerBody): Edge[] {
  return [
    ...graph.edges.map((e): Edge => {
      const from = graph.nodes.find((n) => n.id === e.from.node);
      const to = graph.nodes.find((n) => n.id === e.to.node);
      const op = portOf(from, e.from.port, 'out', body);
      const ip = portOf(to, e.to.port, 'in', body);
      const s = edgeStyle((op?.type ?? 'VideoFrame') as EdgeType, op?.subtype);
      const decode = op?.type === 'EncodedVideoStream' && ip?.type === 'VideoFrame';
      return {
        id: e.id, source: e.from.node, sourceHandle: e.from.port, target: e.to.node, targetHandle: e.to.port,
        style: { stroke: s.stroke, strokeWidth: s.width, strokeDasharray: s.dash },
        className: 'etype-' + (op?.type ?? 'x'),
        // L4: the domain transition is visible on the wire, not hidden in a node.
        label: decode ? '⎍ decode' : undefined,
        labelStyle: { fill: 'var(--txt-2)', fontSize: 9 },
        labelBgStyle: { fill: 'var(--panel)' },
        labelBgPadding: [4, 2] as [number, number],
      };
    }),
    ...lfoEdges,
  ];
}

// ---------- canvas ----------

function Canvas({ block, blockIndex, fitOnResize, at, graph, body, container }: { block: Block; blockIndex: number; fitOnResize?: boolean; at: GraphAt; graph: BlockGraph; body?: ContainerBody; container?: NodeInstance }) {
  const rf = useReactFlow();
  // Inside Compose the graph's pane changes size (Arrange ↔ Process, small windows): re-frame the
  // chain when it does, so it never sits half out of view.
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current?.closest('.canvaswrap');
    if (!fitOnResize || !el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => (clearTimeout(t), (t = setTimeout(() => void rf.fitView(FIT), 120))));
    ro.observe(el);
    return () => (clearTimeout(t), ro.disconnect());
  }, [fitOnResize, rf]);
  const freezes = useProject((d) => d.freezes);
  const lfos = useProject((d) => d.modulators.lfos);
  const values = useProject((d) => d.modulators.values);
  const bpm = useProject((d) => d.settings.bpm);
  const view = useProject((d) => d.view.perBlock[block.id]);
  const [nodes, setNodes] = useState<Node[]>([]);
  // The latest controlled projection may not have reached RF's internal store yet when a
  // measurement/position event arrives. Keep those events on this projection, not rf.getNodes().
  const projectedNodes = useRef<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  // Project the store into React Flow state, keeping RF's own fields (measured size, selection).
  useEffect(() => {
    const lfoNodes: Node[] = [];
    const lfoEdges: Edge[] = [];
    // Ghosts sit in a row under the graph so they never cover a real node.
    const floor = Math.max(0, ...graph.nodes.map((n) => n.position.y)) + 190;
    graph.nodes.forEach((n) =>
      Object.entries(n.bindings).forEach(([key, b]) => {
        // Phase 1.5: a Value's ghost, wired the same way (a binding, not a graph wire).
        const pv = b.value && values?.find((x) => x.id === b.value!.valueId);
        if (pv) {
          const vid = 'val:' + pv.id;
          if (!lfoNodes.some((g) => g.id === vid)) lfoNodes.push({ id: vid, type: 'lfo', position: { x: n.position.x - 60 + lfoNodes.length * 160, y: floor }, draggable: false, selectable: false, deletable: false, data: { label: pv.label, period: pv.value.toFixed(2), kind: 'VALUE' } });
          const pd = defOf(n.kind)?.params.find((p) => p.key === key);
          lfoEdges.push({
            id: `mod:val:${pv.id}:${n.id}:${key}`, source: vid, sourceHandle: 'out', target: n.id, targetHandle: '__mod', selectable: false, deletable: false,
            style: { stroke: 'var(--gold)', strokeWidth: 1.5, strokeDasharray: '2 3' }, label: `◆ ${pd?.label ?? key} · ${+b.value!.from.toFixed(2)}→${+b.value!.to.toFixed(2)}`,
            labelStyle: { fill: 'var(--gold)', fontSize: 9 }, labelBgStyle: { fill: 'var(--panel)' },
          });
        }
        const l = b.lfo && lfos.find((x) => x.id === b.lfo!.lfoId);
        if (!l) return;
        const gid = 'lfo:' + l.id;
        if (!lfoNodes.some((g) => g.id === gid)) {
          lfoNodes.push({ id: gid, type: 'lfo', position: { x: n.position.x - 60 + lfoNodes.length * 160, y: floor }, draggable: false, selectable: false, deletable: false, data: { label: l.label, period: l.unit === 'beats' ? fmtBeats(l.period, bpm, false) : `${l.period} s` } });
        }
        const pdef = defOf(n.kind)?.params.find((p) => p.key === key);
        lfoEdges.push({
          id: `mod:${l.id}:${n.id}:${key}`, source: gid, sourceHandle: 'out', target: n.id, targetHandle: '__mod', selectable: false, deletable: false,
          style: { stroke: 'var(--gold)', strokeWidth: 1.5, strokeDasharray: '2 3' }, label: `~ ${pdef?.label ?? key} · ${b.lfo!.depth}`,
          labelStyle: { fill: 'var(--gold)', fontSize: 9 }, labelBgStyle: { fill: 'var(--panel)' },
        });
      }),
    );
    // The store's selection is authoritative (M1: the CT selects too). When its node is not selected on
    // the canvas, the change came from outside: select exactly it. Otherwise keep the canvas's own
    // (multi-)selection, which the store only mirrors as its first node.
    const want = view?.selected[0];
    const nextNodes = ((prev: Node[]) => {
      const outside = !!want && !prev.some((p) => p.id === want && p.selected);
      return [
        ...graph.nodes.map((n): Node => {
          const old = prev.find((p) => p.id === n.id);
          const data: NData = { block, at, body, node: n, def: defOf(n.kind), frozen: isFrozen({ freezes } as never, { kind: 'node', blockId: block.id, nodeId: n.id }), viewed: view?.viewer === n.id };
          const selected = !want ? false : outside ? n.id === want : old ? old.selected : view?.selected.includes(n.id);
          return { id: n.id, type: 'mp', position: n.position, data, measured: old?.measured, selected, dragHandle: '.gt' };
        }),
        ...lfoNodes.map((g) => ({ ...g, measured: prev.find((p) => p.id === g.id)?.measured })),
      ];
    })(projectedNodes.current);
    projectedNodes.current = nextNodes;
    setNodes(nextNodes);
    setEdges((prev) => buildEdges(graph, lfoEdges, body).map((e) => ({ ...e, selected: prev.find((p) => p.id === e.id)?.selected })));
  }, [block, graph, body, at, freezes, lfos, values, bpm, view?.viewer, view?.selected]);

  // Register the bridge for the library's click/drag-to-add.
  useEffect(() => {
    const el = host.current?.closest('.canvaswrap')?.querySelector('.react-flow') as HTMLElement | null; // this canvas's own (both can be mounted)
    const bridge: CanvasBridge = {
      at,
      flowAt(x, y) {
        const r = el?.getBoundingClientRect();
        if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
        return rf.screenToFlowPosition({ x, y });
      },
      center() {
        const r = el?.getBoundingClientRect();
        return r ? rf.screenToFlowPosition({ x: r.left + r.width / 2 - 78, y: r.top + r.height / 2 - 40 }) : { x: 0, y: 0 };
      },
    };
    canvasBridge.set(bridge);
    return () => { if (canvasBridge.get() === bridge) canvasBridge.set(null); };
  }, [rf, scopeKey(at)]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Only RF's explicit selection changes represent user intent. onSelectionChange also fires
      // while controlled nodes are being projected from the store, so writing there echoes stale
      // canvas state over CT/external selection and can loop between two mounted canvases.
      const next = applyNodeChanges(changes, projectedNodes.current);
      projectedNodes.current = next;
      setNodes(next);
      if (changes.some(c => c.type === 'select')) {
        const first = next.find(n => n.type === 'mp' && n.selected)?.id ?? null;
        if (first !== (getDoc().view.perBlock[block.id]?.selected[0] ?? null)) selectNode(block.id, first as never);
      }
      const moved = changes.filter((c): c is Extract<NodeChange, { type: 'position' }> => c.type === 'position' && c.dragging === false && !!c.position);
      if (moved.length) moveNodes(at, moved.map((c) => ({ id: c.id, x: Math.round(c.position!.x), y: Math.round(c.position!.y) })));
    },
    [at, block.id],
  );
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  const onConnect = useCallback(
    (c: Connection) => {
      const to = { node: c.target as never, port: c.targetHandle as never };
      try {
        connect(at, { node: c.source as never, port: c.sourceHandle as never }, to);
      } catch (e) {
        toastError(e, fixFor(e, block.id, to));
      }
    },
    [at, block.id],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => !connectionError(at, { node: c.source as never, port: (c.sourceHandle ?? '') as never }, { node: c.target as never, port: (c.targetHandle ?? '') as never }),
    [at],
  );

  const [showMini, setShowMini] = useSticky('graph.mini', true);
  const [showGrid, setShowGrid] = useSticky('graph.grid', true);
  const selection = () => rf.getNodes().filter((n) => n.selected && n.type === 'mp').map((n) => n.id);
  // How many groupable nodes are selected (not the Source, Output or a Group node): drives the Group button.
  const [groupable, setGroupable] = useState(0);
  const onSelectionChange = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    setGroupable(sel.filter(n => n.type === 'mp' && !['source.clip', 'output.sink', 'group.in', 'group.out', CONTAINER_KIND].includes((n.data as NData).node.kind)).length);
  }, []);

  /** Everything the radial needs, positioned at a screen point (optionally wiring from a socket). */
  const menuCtx = (pt: { x: number; y: number }, wireFrom?: PortRef & { type: EdgeType }): NodeMenuCtx => {
    const p = rf.screenToFlowPosition(pt);
    const needTwo = (fn: (ids: string[]) => void) => () => {
      const ids = selection();
      if (ids.length < 2) return toast('Select two or more nodes first (drag a box, or Shift-click)', { kind: 'warn' });
      fn(ids);
    };
    return {
      fromType: wireFrom?.type,
      allowLooks: !container,
      add: (def) => {
        try {
          const id = addNode(at, def.kind, { x: Math.round(p.x - 84), y: Math.round(p.y - 30) }, wireFrom && { node: wireFrom.node, port: wireFrom.port });
          selectNode(block.id, id);
          toast(`Added ${def.label}${wireFrom ? ' and wired it' : ''}`, { kind: 'ok', action: undoAction() });
        } catch (e) {
          toastError(e);
        }
      },
      recipe: (r) => {
        try {
          if (!applyRecipe(block.id, r)) return;
          toast(`Applied ${r.nm} to the block`, { kind: 'ok', action: undoAction() });
        } catch (e) {
          toastError(e);
        }
      },
      organise: tidy,
      serial: needTwo((ids) => toast(`Chained ${chainNodes(at, ids)} wires in series`, { kind: 'ok', action: undoAction() })),
      parallel: needTwo((ids) => {
        if (branchParallel(at, ids)) toast(`Branched ${ids.length} nodes in parallel with a Mix`, { kind: 'ok', action: undoAction() });
      }),
      align: needTwo((ids) => {
        const ns = graph.nodes.filter((n) => ids.includes(n.id));
        const y = Math.round(ns.reduce((a, n) => a + n.position.y, 0) / ns.length);
        moveNodes(at, ns.map((n) => ({ id: n.id, x: n.position.x, y })));
        toast('Aligned on one row', { action: undoAction() });
      }),
      // One level only: inside a container there is no Group.
      group: container ? undefined : () => {
        const ids = selection();
        if (!ids.length) return toast('Select the nodes to group first (drag a box, or Shift-click)', { kind: 'warn' });
        try {
          const id = collapseNodes(at, ids);
          selectNode(block.id, id);
          toast(`Grouped ${ids.length} node${ids.length > 1 ? 's' : ''}: double-click the container to open it`, { kind: 'ok', action: undoAction() });
        } catch (e) {
          toastError(e);
        }
      },
      unpack: container ? undefined : () => {
        const c = graph.nodes.find((n) => n.kind === CONTAINER_KIND && selection().includes(n.id));
        if (!c) return toast('Select a container to unpack', { kind: 'warn' });
        unpackNodes(block.id, c.id);
        toast(`Unpacked ${nodeLabel(c)}: its nodes are back in the block`, { kind: 'ok', action: undoAction() });
      },
      fitAll: () => void rf.fitView({ ...FIT, duration: 250 }),
      fitSelection: () => {
        const ids = selection();
        if (!ids.length) return toast('Nothing selected to frame', { kind: 'warn' });
        void rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.4, duration: 250 });
      },
      zoom100: () => void rf.zoomTo(1, { duration: 200 }),
      toggleMinimap: () => setShowMini((v) => !v),
      toggleGrid: () => setShowGrid((v) => !v),
    };
  };

  const openRoot = (x: number, y: number, holdKey?: string) => { const c = menuCtx({ x, y }); openRadial({ x, y, title: 'Node menu', items: rootRing(c), holdKey, tabSearch: searchAll(c) }); };

  // A wire dropped on empty canvas -> the Add ring, filtered to nodes that accept it, auto-wired.
  const [refusal, setRefusal] = useState<{ x: number; y: number; head: string; why: string; fix?: { label: string; run: () => void } } | null>(null);
  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => setRefusal(null), 6000);
    return () => clearTimeout(t);
  }, [refusal]);
  const onConnectStart: OnConnectStart = (_e, p) => {
    if (p.nodeId && p.handleId && p.handleType) wireDrag.set({ key: scopeKey(at), node: p.nodeId, port: p.handleId, from: p.handleType });
  };
  const onConnectEnd: OnConnectEnd = (e, state) => {
    wireDrag.set(null);
    if (state.isValid || !state.fromNode) return;
    if (state.toHandle) {
      // Phase 1.2: the reason sits where the wire was dropped, with its fix when there is one.
      const fromIsOut = state.fromHandle?.type !== 'target';
      const a = { node: state.fromNode.id as never, port: (state.fromHandle?.id ?? '') as never };
      const b = { node: state.toHandle.nodeId as never, port: (state.toHandle.id ?? '') as never };
      const [from, to] = fromIsOut ? [a, b] : [b, a];
      const err = connectionError(at, from, to);
      if (!err) return;
      const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
      const tf = portTypeOf(graph, from.node, from.port, 'out', body), tt = portTypeOf(graph, to.node, to.port, 'in', body);
      const head = err.code === 'GRAPH_TYPE_MISMATCH' && tf && tt ? `Needs ${DOMAIN_SHORT[tt]} · got ${DOMAIN_SHORT[tf]}` : err.humanMessage;
      // The hint names the domains: a picture cannot go back into the stream (there is no Encode
      // node yet), and an encoded wire reaches picture inputs through the Decode.
      const why = err.code !== 'GRAPH_TYPE_MISMATCH' ? err.suggestedFix
        : tt === 'EncodedVideoStream' ? 'Encoded inputs take the stream before the Decode: wire from the Source or a Mosh node.'
        : tf === 'EncodedVideoStream' ? 'Picture inputs take frames after the Decode: wire from the Decode node.'
        : err.suggestedFix;
      setRefusal({ x: pt.clientX, y: pt.clientY, head, why, fix: fixFor(err, block.id, to) });
      return;
    }
    if (state.fromHandle?.type !== 'source') return;
    const from = graph.nodes.find((n) => n.id === state.fromNode!.id);
    const type = portOf(from, state.fromHandle!.id!, 'out', body)?.type;
    if (!from || !type) return;
    const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
    const ctx = menuCtx({ x: pt.clientX, y: pt.clientY }, { node: from.id, port: state.fromHandle.id as never, type });
    openRadial({ x: pt.clientX, y: pt.clientY, title: `Add · ${edgeStyle(type).label} in`, items: addRing(ctx), backSlot: true, tabSearch: searchAll(ctx) });
  };

  // Hold A over the canvas -> press-drag-release radial at the cursor.
  useEffect(() => {
    let over = false;
    let at = { x: 0, y: 0 };
    // This canvas's own wrapper (MOSH and the full-screen graph can both be mounted: a global lookup found the wrong one).
    const el = host.current?.closest('.canvaswrap') as HTMLElement | null;
    // A move counts as over too: this effect re-registers on every render, and a pointer already inside fires no pointerenter.
    const move = (e: PointerEvent) => ((at = { x: e.clientX, y: e.clientY }), (over = true));
    const enter = () => (over = true);
    const leave = () => (over = false);
    // The canvas has focus from a press inside it until a press elsewhere: Ctrl+G, Ctrl+Shift+G and
    // Esc follow focus (bug hunt), so they work with the pointer resting on the inspector too.
    const press = (e: PointerEvent) => (canvasFocus = !!el && e.target instanceof Node && el.contains(e.target));
    const down = (e: KeyboardEvent) => {
      if (!(over || canvasFocus) || e.repeat || e.defaultPrevented || e.isComposing || blocksShortcutTarget(e.target)) return;
      // 3.4 / 3.5: Ctrl+G groups the selection, Ctrl+Shift+G unpacks the selected container, Esc leaves one.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        const c = menuCtx(at);
        if (e.shiftKey) c.unpack?.(); else c.group?.();
        return;
      }
      if (e.key === 'Escape' && container && !document.querySelector('.radialoverlay')) return void openContainer(block.id, null);
      // Hold-A opens the radial at the pointer, so it stays pointer-over only.
      if (!over || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'a') return;
      e.preventDefault();
      openRoot(at.x, at.y, 'a');
    };
    window.addEventListener('pointerdown', press, true);
    el?.addEventListener('pointermove', move);
    el?.addEventListener('pointerenter', enter);
    el?.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', down);
    return () => {
      el?.removeEventListener('pointermove', move);
      el?.removeEventListener('pointerenter', enter);
      el?.removeEventListener('pointerleave', leave);
      window.removeEventListener('keydown', down);
      window.removeEventListener('pointerdown', press, true);
    };
  });

  // Deleting a container deletes a whole look: offer Unpack instead, before React Flow removes anything.
  const onBeforeDelete = useCallback(async ({ nodes: dn, edges: de }: { nodes: Node[]; edges: Edge[] }) => {
    const boxes = dn.filter((n) => n.type === 'mp' && (n.data as NData).node.kind === CONTAINER_KIND).map((n) => (n.data as NData).node);
    if (!boxes.length) return { nodes: dn, edges: de };
    const names = boxes.map((b) => nodeLabel(b)).join(', ');
    const pick = await choose<'unpack' | 'delete' | 'cancel'>(`Delete ${names}?`, `${boxes.length > 1 ? 'They are containers' : 'It is a container'}: deleting takes everything inside with it. Unpack keeps the nodes in the block.`, [
      { label: 'Unpack instead', value: 'unpack', kind: 'primary' },
      { label: 'Delete', value: 'delete', kind: 'danger' },
      { label: 'Cancel', value: 'cancel', kind: 'ghost' },
    ]);
    if (pick === 'unpack') transact(() => boxes.forEach((b) => unpackNodes(block.id, b.id)));
    return pick === 'delete' ? { nodes: dn, edges: de } : false;
  }, [block.id]);

  const onDelete = useCallback(
    ({ nodes: dn, edges: de }: { nodes: Node[]; edges: Edge[] }) => {
      const ids = dn.filter((n) => n.type === 'mp').map((n) => n.id);
      const eids = de.filter((e) => !e.id.startsWith('mod:') && !ids.includes(e.source) && !ids.includes(e.target)).map((e) => e.id);
      // Nodes and the loose wires go together, so one Undo brings both back.
      transact(() => {
        if (ids.length) removeNodes(at, ids);
        if (eids.length) removeEdges(at, eids);
      });
      if (ids.length || eids.length) toast(`Deleted ${ids.length ? ids.length + ' node' + (ids.length > 1 ? 's' : '') : eids.length + ' wire' + (eids.length > 1 ? 's' : '')}`, { action: undoAction() });
    },
    [at],
  );

  function tidy() {
    const pos = organise(
      graph.nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, isDelay: n.kind === 'route.delay' })),
      graph.edges.map((e) => ({ from: e.from.node, to: e.to.node })),
    );
    moveNodes(at, pos);
    setTimeout(() => rf.fitView({ ...FIT, duration: 250 }), 50);
    toast('Organised: left-to-right by signal flow', { action: undoAction() });
  }

  const C = block.kind === 'picture' ? 'var(--sky)' : 'var(--coral)';
  return (
    <>
    <CanvasGestures edgeIds={graph.edges.map((e) => e.id)} revision={graph} onMenu={openRoot} onCut={(ids) => {
      if (!ids.length) return toast('No graph wires crossed');
      removeEdges(at, ids);
      toast(`Cut ${ids.length} wire${ids.length === 1 ? '' : 's'}`, { action: undoAction() });
    }}>
    <ReactFlow
      onDoubleClick={(e) => {
        if ((e.target as Element).closest('.react-flow__edge')) return; // a wire: onEdgeDoubleClick adds a Reroute
        if ((e.target as Element).closest('.react-flow__pane')) openRoot(e.clientX, e.clientY);
      }}
      onNodeDoubleClick={(e, n) => {
        if (n.type !== 'mp' || (n.data as NData).node.kind !== CONTAINER_KIND) return;
        // Opening re-mounts the canvas; done inside this event, the new canvas's pane caught the same
        // double-click and opened the radial. Stop it here and open on the next tick.
        e.stopPropagation();
        setTimeout(() => openContainer(block.id, n.id), 0);
      }}
      onEdgeDoubleClick={(e, edge) => {
        if (edge.id.startsWith('mod:')) return; // an LFO's ghost wire is not a graph wire
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        if (insertReroute(at, edge.id as never, { x: p.x - 20, y: p.y - 20 })) toast('Added a Reroute: drag it to tidy the wire', { kind: 'ok', action: undoAction() });
      }}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectStart={onConnectStart}
      onConnectEnd={onConnectEnd}
      isValidConnection={isValidConnection}
      onBeforeDelete={onBeforeDelete}
      onDelete={onDelete}
      onSelectionChange={onSelectionChange}
      onMoveEnd={(_e, vp) => !container && setBlockPanZoom(block.id, { x: vp.x, y: vp.y }, vp.zoom)}
      defaultViewport={view && !container ? { x: view.pan.x, y: view.pan.y, zoom: view.zoom } : undefined}
      fitView={!!container || !view || (view.pan.x === 0 && view.pan.y === 0)}
      fitViewOptions={FIT}
      zoomOnDoubleClick={false}
      panOnDrag={[0, 1]}
      deleteKeyCode={['Delete', 'Backspace']}
      // Shift-click adds to the selection, as every hint in the app says (React Flow's default is Ctrl on Windows).
      multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
      minZoom={0.2}
      maxZoom={2.5}
      colorMode="dark"
    >
      <div ref={host} style={{ display: 'none' }} />
      {showGrid && <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(255,255,255,.08)" />}
      {showMini && <MiniMap pannable zoomable style={{ width: 150, height: 96 }} nodeColor={(n) => (n.type === 'lfo' ? CAT_HEX.Routing : CAT_HEX[(n.data as NData).def?.category ?? 'Effect'])} maskColor="rgba(13,14,18,.7)" />}
      <div className="ctoolbar">
        <button
          className="cb"
          onClick={(e) => {
            const r = (e.currentTarget.closest('.react-flow') as HTMLElement).getBoundingClientRect();
            openRoot(r.left + r.width / 2, r.top + r.height / 2);
          }}
          title="Radial menu — right-click or double-click the canvas, or hold A and flick. Right-drag cuts wires."
        >⊕ radial</button>
        <button className="cb" onClick={() => rf.fitView({ ...FIT, duration: 250 })} title="Frame all nodes">⤢ fit</button>
        <button className="cb" onClick={tidy} title="Organise: auto-layout by signal flow">▣ tidy</button>
        {!container && groupable > 0 && (
          <button className="cb grp" onClick={() => menuCtx({ x: 0, y: 0 }).group?.()} title="Group the selected nodes into one container: a node you can open, unpack, give knobs and save as a look (Ctrl+G)">▸ Group {groupable} (Ctrl+G)</button>
        )}
      </div>
      <div className="blockcue">
        {container ? (
          <span className="crumbs">
            <button className="crumb" onClick={() => openContainer(block.id, null)} title="Back to the block's graph">‹ {blockName(block, blockIndex)}</button>
            <span aria-hidden>›</span> <b>{nodeLabel(container)}</b>
            <span className="scopetag ctr">container</span>
          </span>
        ) : (
          <><span className="scopetag block" style={{ color: C, borderColor: C }}>block scope</span>editing <b>{blockName(block, blockIndex)}</b> graph</>
        )}
      </div>
    </ReactFlow>
    </CanvasGestures>
    {refusal && <RefusalChip r={refusal} close={() => setRefusal(null)} />}
    </>
  );
}

// The minimap paints SVG fills, which do not resolve var(): read the category tokens once (Polish 4).
const tokenHex = (cat: string) => { const v = CATS[cat as keyof typeof CATS]?.accent.match(/var\((--[^)]+)\)/)?.[1]; return v ? getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888' : '#888'; };
const CAT_HEX: Record<string, string> = new Proxy({} as Record<string, string>, { get: (memo, k: string) => (memo[k] ??= tokenHex(k)) });

/** Phase 1.1: a refused wire that has a one-click fix offers it (a second decode → feed from Decode). */
/** A port's type, by node and key ('in' = an input). */
function portTypeOf(graph: BlockGraph, node: string, port: string, side: 'in' | 'out', body?: ContainerBody): EdgeType | undefined {
  return portOf(graph.nodes.find((x) => x.id === node), port, side, body)?.type;
}

/** Phase 1.2: why a wire was refused, at the socket it was dropped on (role=alert), with its fix. */
function RefusalChip({ r, close }: { r: { x: number; y: number; head: string; why: string; fix?: { label: string; run: () => void } }; close: () => void }) {
  return (
    <div className="wirerefusal" role="alert" style={{ left: r.x + 12, top: r.y + 12 }} onPointerDown={(e) => e.stopPropagation()}>
      <b><span aria-hidden>✕</span> {r.head}</b>
      {r.why && <span className="why">{r.why}</span>}
      <span className="acts">
        {r.fix && <button className="pop" onClick={() => (r.fix!.run(), close())}>{r.fix.label}</button>}
        <button className="ghostbtn" onClick={close} aria-label="Dismiss">Dismiss</button>
      </span>
    </div>
  );
}

function fixFor(e: unknown, blockId: BlockId, to: PortRef): { label: string; run: () => void } | undefined {
  if ((e as { code?: string })?.code !== 'GRAPH_SECOND_DECODE') return undefined;
  return {
    label: 'Feed from Decode',
    run: () => {
      const r = feedFromDecode(blockId, to);
      if (r.ok) toast('Fed from Decode: one decode for the whole block', { kind: 'ok', action: undoAction() });
      else toast(r.why, { kind: 'warn' });
    },
  };
}

export function GraphCanvas({ fitOnResize }: { fitOnResize?: boolean } = {}) {
  const { block, blockIndex } = useActive();
  const opened = useUi((s) => (block ? s.opened[block.id] : undefined));
  if (!block) return <Empty icon="◆" title="No block selected">Pick a block on the timeline to edit its graph.</Empty>;
  // 3.2: an open container's graph replaces the block's (one level: a container holds no container).
  const container = opened ? block.graph.nodes.find((n) => n.id === opened && n.kind === CONTAINER_KIND && n.body) : undefined;
  const at: GraphAt = container ? { blockId: block.id, container: container.id } : block.id;
  return (
    <div className="canvaswrap">
      <ReactFlowProvider>
        {/* One React Flow per block (and per open container): per-block pan/zoom/selection restore on switch (D3). */}
        <Canvas key={block.id + (container?.id ?? '')} block={block} blockIndex={blockIndex} fitOnResize={fitOnResize} at={at} graph={container ? container.body!.graph : block.graph} body={container?.body} container={container} />
      </ReactFlowProvider>
    </div>
  );
}

export function CanvasLegends() {
  const edges = useMemo(() => (['EncodedVideoStream', 'VideoFrame', 'Field', 'Scalar', 'Event'] as EdgeType[]).map((t) => ({ t, s: edgeStyle(t) })), []);
  return (
    <>
      <div className="catlegend">
        <span className="lghead">Node types:</span>
        {Object.entries(CATS).map(([k, c]) => (
          <span key={k} title={c.desc}><i style={{ background: c.accent }} />{c.icon} {k}{k === 'Audio' && <span className="dim"> (reserved)</span>}</span>
        ))}
      </div>
      <div className="catlegend">
        <span className="lghead">Edges:</span>
        {edges.map(({ t, s }) => (
          <span key={t} title={t === 'EncodedVideoStream' ? 'A Mosh node consumes the raw bitstream, not a decoded image' : t}>
            <svg width="24" height="8" aria-hidden><line x1="0" y1="4" x2="24" y2="4" stroke={s.stroke} strokeWidth={s.width} strokeDasharray={s.dash} /></svg>
            {t === 'EncodedVideoStream' ? 'encoded → Mosh' : s.label}
          </span>
        ))}
        <span className="dim" style={{ marginLeft: 'auto' }}>one wire per input · cycles only via Delay · ⎍ = implicit decode</span>
      </div>
      <div className="catlegend">
        <span className="radialhint">⊕ <b>right-click / double-click canvas</b> or <b>hold A</b> + flick = radial menu</span>
        <span className="radialhint">✂ <b>right-drag</b> across wires to cut · release to apply · <b>Esc</b> cancels · <b>Ctrl+Z</b> restores the stroke · left/middle-drag pans</span>
        <span className="radialhint">⟜ drop a wire on empty canvas = add a node that accepts it, wired · Delete removes</span>
        <span className="radialhint">▸ <b>Ctrl+G</b> groups the selection into a container · double-click one to open it · <b>Esc</b> back · <b>Ctrl+Shift+G</b> unpacks</span>
      </div>
    </>
  );
}

// Re-exported for the library's drag-to-add.
export { addNode };
