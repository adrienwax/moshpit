import { memo, useMemo } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { Block, BlockId, NodeId } from '@moshpit/engine';
import { defOf } from '../../engine';
import { compositionId, compositionMove, compositionProjection } from '../../lib/compositionGraph';
import { edgeStyle } from '../../lib/cats';
import { getDoc, isFrozen, moveBlock, ports, selectBlock, selectNode, setBlock, setView, useProject } from '../../state/project';
import { openContainer } from '../../state/ui';
import { Empty } from '../../qol/qol';
import { MpNode, type NData } from './GraphCanvas';
import './composition.css';

type GroupData = { block: Block; index: number; name: string; frames: number; seconds: number; active: boolean; open: (id: BlockId) => void };

export function selectCompositionNode(blockId: BlockId, nodeId: NodeId | null) {
  const doc = getDoc(), block = doc.timeline.blocks.find(b => b.id === blockId);
  if (!block || (nodeId && !block.graph.nodes.some(n => n.id === nodeId))) return;
  // Clear a remembered nested scope before selecting a top-level node on the overview.
  openContainer(blockId, null);
  const selection = doc.view.perBlock[blockId]?.selected ?? [];
  if (doc.view.activeBlock === blockId && selection.length === (nodeId ? 1 : 0) && selection[0] === (nodeId ?? undefined)) return;
  // Publish block + node atomically, so the controller never sees another block's old node.
  setView(v => {
    v.activeBlock = blockId;
    const view = (v.perBlock[blockId] ??= { pan: { x: 0, y: 0 }, zoom: 1, selected: [] });
    view.selected = nodeId ? [nodeId] : [];
  });
}

export function moveCompositionBlock(id: BlockId, delta: -1 | 1) {
  const move = compositionMove(getDoc().timeline.blocks, id, delta);
  return move ? moveBlock(move.from, move.to) : false;
}

export function setCompositionJoin(id: BlockId, kind: Block['kind']) {
  const blocks = getDoc().timeline.blocks, index = blocks.findIndex(b => b.id === id);
  if (index < 0 || (index === 0 && kind !== 'picture') || blocks[index].kind === kind) return;
  setBlock(id, { kind }, kind === 'motion' ? 'Join with mosh' : 'Join with cut');
}

const Group = memo(function Group({ data }: NodeProps<Node<GroupData>>) {
  const { block, index } = data;
  const blocks = useProject(d => d.timeline.blocks);
  return <div className={'composition-group' + (data.active ? ' active' : '')}>
    <Handle type="target" position={Position.Left} id="sequence-in" className="composition-sequence-port" isConnectable={false} />
    <Handle type="source" position={Position.Left} id="sequence-out" className="composition-sequence-port" isConnectable={false} />
    <div className="composition-group-head nodrag nopan" onClick={e => { if (!(e.target as HTMLElement).closest('button')) selectCompositionNode(block.id, null); }}>
      <span className="composition-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="composition-clip-name">{block.label || data.name}</span>
      <span className="composition-length">{data.seconds}s <span>· {data.frames}f</span></span>
      <div className="composition-join" role="group" aria-label={`Block ${index + 1} incoming join`}>
        {index === 0 ? <span className="composition-start">Start · Picture</span> : <>
          <button className={block.kind === 'picture' ? 'on' : ''} aria-pressed={block.kind === 'picture'} onClick={() => setCompositionJoin(block.id, 'picture')}>Cut</button>
          <button className={block.kind === 'motion' ? 'on' : ''} aria-pressed={block.kind === 'motion'} onClick={() => setCompositionJoin(block.id, 'motion')}>Mosh</button>
        </>}
      </div>
      <button disabled={!compositionMove(blocks, block.id, -1)} onClick={() => moveCompositionBlock(block.id, -1)} aria-label={`Move Block ${index + 1} earlier`}>↑</button>
      <button disabled={!compositionMove(blocks, block.id, 1)} onClick={() => moveCompositionBlock(block.id, 1)} aria-label={`Move Block ${index + 1} later`}>↓</button>
      <button onClick={() => data.open(block.id)}>Edit chain ↗</button>
    </div>
  </div>;
});

const Effect = memo(function Effect(props: NodeProps<Node<NData>>) {
  // Bind parameter scrubs before their own pointer handler runs. Ordinary node
  // selection waits for click: changing the controlled Flow tree during a title
  // press can replace its hit target before pointerup and turn it into a pane click.
  return <div className="nopan" onPointerDownCapture={e => {
    if ((e.target as HTMLElement).closest('.scrub-field-mini')) selectCompositionNode(props.data.block.id, props.data.node.id);
  }} onFocusCapture={e => {
    if ((e.target as HTMLElement).closest('.scrub-field-mini')) selectCompositionNode(props.data.block.id, props.data.node.id);
  }}><MpNode {...props} /></div>;
});
const nodeTypes = { compositionGroup: Group, compositionEffect: Effect };

function Canvas({ onOpenBlock }: { onOpenBlock?: (blockId: BlockId) => void }) {
  const doc = useProject(d => d), rf = useReactFlow();
  const rows = useMemo(() => compositionProjection(doc.timeline.blocks), [doc.timeline.blocks]);
  const open = (id: BlockId) => {
    const block = getDoc().timeline.blocks.find(b => b.id === id);
    if (!block) return;
    selectBlock(block.id); openContainer(id, null); onOpenBlock?.(id);
  };
  const nodes: Node[] = [], edges: Edge[] = [];
  for (const row of rows) {
    const { block } = row;
    nodes.push({ id: row.id, type: 'compositionGroup', position: row.position, style: { width: row.width, height: row.height },
      draggable: false, selectable: false, connectable: false, deletable: false,
      data: { block, index: row.index, name: doc.resources.sources.find(s => s.id === block.sourceId)?.name ?? 'Missing clip', frames: row.frames,
        seconds: +(row.frames * doc.settings.fps.den / doc.settings.fps.num).toFixed(2), active: doc.view.activeBlock === block.id, open } });
    const view = doc.view.perBlock[block.id];
    for (const node of block.graph.nodes) nodes.push({ id: compositionId(block.id, 'node', node.id), type: 'compositionEffect', parentId: row.id,
      position: { x: node.position.x + row.offset.x, y: node.position.y + row.offset.y }, draggable: false, connectable: false, deletable: false,
      selected: doc.view.activeBlock === block.id && !!view?.selected.includes(node.id),
      data: { block, at: block.id, node, def: defOf(node.kind), frozen: isFrozen(doc, { kind: 'node', blockId: block.id, nodeId: node.id }), viewed: view?.viewer === node.id } });
    for (const edge of block.graph.edges) {
      const from = block.graph.nodes.find(n => n.id === edge.from.node);
      const port = from && ports(from, 'out').find(p => p.key === edge.from.port);
      const style = edgeStyle(port?.type ?? 'VideoFrame', port?.subtype);
      edges.push({ id: compositionId(block.id, 'edge', edge.id), source: compositionId(block.id, 'node', edge.from.node), sourceHandle: edge.from.port,
        target: compositionId(block.id, 'node', edge.to.node), targetHandle: edge.to.port, selectable: false, deletable: false,
        style: { stroke: style.stroke, strokeWidth: style.width, strokeDasharray: style.dash } });
    }
    if (row.previous) edges.push({ id: compositionId(block.id, 'join'), source: compositionId(row.previous, 'group'), sourceHandle: 'sequence-out', target: row.id, targetHandle: 'sequence-in', type: 'smoothstep',
      label: block.kind === 'motion' ? 'MOSH' : 'CUT', selectable: false, deletable: false, className: 'composition-seam',
      style: { stroke: block.kind === 'motion' ? 'var(--gold)' : 'var(--txt-2)', strokeWidth: 3, strokeDasharray: '6 5' },
      labelStyle: { fill: 'var(--txt)', fontSize: 12, fontWeight: 700 }, labelBgStyle: { fill: 'var(--panel)' } });
  }
  if (!rows.length) return <Empty icon="◇" title="No clips in the composition">Add clips in IN or MOSH to build a sequence.</Empty>;
  return <div className="composition-canvas">
    <div className="composition-tools">
      <span>Clip sequence <span className="dim">· edit values here; open a chain to wire</span></span>
      <button onClick={() => void rf.fitView({ padding: 0.1, maxZoom: 0.8 })}>Fit all</button>
      <button onClick={() => { const row = rows.find(r => r.block.id === doc.view.activeBlock) ?? rows[0]; void rf.fitView({ nodes: [{ id: row.id }], padding: 0.1, maxZoom: 0.8 }); }}>Fit selected</button>
    </div>
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.12, maxZoom: 0.8 }} minZoom={0.08} maxZoom={1.5}
      nodesConnectable={false} nodesDraggable={false} edgesReconnectable={false} deleteKeyCode={null} selectionKeyCode={null} zoomOnDoubleClick={false}
      onNodeClick={(_, n) => { if (n.type === 'compositionEffect') { const d = n.data as NData; selectCompositionNode(d.block.id, d.node.id); } }}
      onNodeDoubleClick={(_, n) => { if (n.type === 'compositionEffect') { const d = n.data as NData; open(d.block.id); if (d.node.body) openContainer(d.block.id, d.node.id); } }}
      onPaneClick={() => { if (doc.view.activeBlock) selectNode(doc.view.activeBlock, null); }}>
      <Background gap={24} /><Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}

export function CompositionCanvas(props: { onOpenBlock?: (blockId: BlockId) => void }) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
