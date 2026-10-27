import { useMemo } from 'react';
import { defOf } from '../../engine';
import { catOf, chainOrder, nodeLabel, useActive } from '../../components/nodes';
import { Timecode } from '../../components/MediaReadout';
import { blockFrames, blockStarts } from '../../lib/timeline';
import { nodesOf, selectBlock, selectNode, useProject } from '../../state/project';
import { setUi, setWs, useUi } from '../../state/ui';
import { useSticky } from '../../state/store';
import { GraphCanvas } from '../node/GraphCanvas';
import { LfoPane } from '../node/NodePanes';
import { BlockPane, RenderPane, SourceDesk } from './ComposePanes';
import { openDeskDetail, inspectSelectedResult, type Detail } from '../../state/desk';
import { FAMILY_COLOUR } from '../../lib/cats';
import { isLinearGraph } from '../../lib/taskDesk';
import { focusAnimation } from '../../state/animation';
import { PreviewSelection } from '../../shell/QuickRender';

export function DeskTools() {
  const { block } = useActive();
  return <nav className="desk-tools" aria-label="MOSH tools">
    <button onClick={() => openDeskDetail('source')}>Source range</button>
    <button disabled={!block} onClick={() => setUi({ fxPanel: true })}>＋ Effects / recipes</button>
    <button disabled={!block} onClick={() => openDeskDetail('graph')}>Graph / routing</button>
    <button onClick={() => openDeskDetail('modulation')}>Modulation</button>
    <button onClick={() => openDeskDetail('capture')}>Capture / recent</button>
  </nav>;
}

export function ViewingContext({ target }: { target: 'program' | 'A' | 'B' }) {
  const { block, blockIndex, selected } = useActive();
  const blocks = useProject(d => d.timeline.blocks);
  const starts = useMemo(() => blockStarts(blocks), [blocks]);
  // Context changes at block boundaries, not on every Edit frame.
  const at = useUi(s => blocks.findIndex((b, i) => s.playhead >= starts[i] && s.playhead < starts[i] + blockFrames(b)));
  const mismatch = !!block && (target !== 'program' || at !== blockIndex);
  return <div className="desk-context" aria-label="Viewing and editing context">
    <span>Viewing <b>{target === 'program' ? `Edit · Block ${at < 0 ? '—' : at + 1}` : `Source ${target}`}</b></span>
    <span>Editing <b>{block ? `Block ${blockIndex + 1}${selected ? ' / ' + nodeLabel(selected) : ''}` : 'No block'}</b></span>
    <span>Transport <b>{target === 'program' ? 'Edit' : `Source ${target}`}</b></span>
    {block && <button className={mismatch ? 'inspect-result suggested' : 'inspect-result'} onClick={inspectSelectedResult}>Inspect selected result</button>}
  </div>;
}

export function BlockContext() {
  const { block, blockIndex } = useActive();
  const fps = useProject(d => d.settings.fps);
  const source = useProject(d => block && d.resources.sources.find(s => s.id === block.sourceId));
  if (!block) return null;
  return <section className="selected-block-context" aria-label="Selected block essentials">
    <header><strong>Editing · Block {blockIndex + 1}</strong><span>{blockIndex === 0 ? 'Start · Picture' : block.kind === 'picture' ? 'Cut · Picture' : 'Mosh · Motion'}</span></header>
    <div className="selected-source">{source?.name ?? 'Missing source'}</div>
    <div className="block-range"><Timecode frame={block.in} fps={fps} /><span>→</span><Timecode frame={block.out} fps={fps} /><strong>{blockFrames(block)} f</strong></div>
    <div className="context-actions"><button onClick={() => openDeskDetail('block')}>Block actions / timing</button><button onClick={inspectSelectedResult}>Inspect result</button></div>
  </section>;
}

export function BlockIndex() {
  const blocks = useProject(d => d.timeline.blocks);
  const { block } = useActive();
  if (!blocks.length) return null;
  return <nav className="block-index" aria-label="Select any block"><span>Blocks</span>{blocks.map((b, i) =>
    <button key={b.id} aria-pressed={b.id === block?.id} onClick={() => selectBlock(b.id)} title={`Block ${i + 1} · ${blockFrames(b)} frames · ${b.kind}`} aria-label={`Select Block ${i + 1}`}>{i + 1}</button>)}</nav>;
}

/** Selection only: the existing Inspector remains the owner of presets, bypass, freeze and macros. */
export function AppliedChain() {
  const { block, selected } = useActive();
  const nodes = block ? chainOrder(block).filter(n => n.kind === 'group.container' || ['Mosh', 'Effect'].includes(defOf(n.kind)?.category ?? '')) : [];
  const linear = block && isLinearGraph(block);
  return <section className="inspector-chain" aria-label="Applied effects">
    <header><strong>Applied effects</strong><button disabled={!block} title="Browse effects and recipes to add to the selected block." onClick={() => setUi({ fxPanel: true })}>＋ Add</button></header>
    {block && !linear && <button className="chain-routing" title="Open the selected block’s connections and containers in the central graph." onClick={() => openDeskDetail('graph')}>Routing / containers · view connections</button>}
    <div className="applied-nodes">{nodes.map((n, i) => {
      const family = defOf(n.kind)?.family;
      return <button key={n.id} data-help-label={nodeLabel(n)} title={defOf(n.kind)?.blurb ?? "A reusable group of effects. Select it to edit its controls."} aria-pressed={n.id === selected?.id} style={{ borderLeftColor: family ? FAMILY_COLOUR[family] : catOf(n).accent }} onClick={() => selectNode(block!.id, n.id)}>
        <span className="chain-position">{linear ? i + 1 : '◇'}</span><span className="chain-label">{nodeLabel(n)}</span><small>{n.bypass ? 'Bypassed' : family ?? (n.kind === 'group.container' ? 'Look' : 'Effect')}</small>
      </button>;
    })}{!nodes.length && <span className="dim">{block ? 'No applied effects' : 'Select a block to inspect its effects'}</span>}</div>
  </section>;
}

export function WorkingDetail() {
  const [detail] = useSticky<Detail>('desk.detail', 'processing');
  const { block } = useActive();
  const source = useUi(s => s.sliceTarget);
  const animation = useUi(s => s.animation);
  const curveBlock = useProject(d => animation ? d.timeline.blocks.find(b => b.id === animation.blockId) : undefined);
  const curveNode = curveBlock && animation ? nodesOf(curveBlock).find(n => n.id === animation.nodeId) : undefined;
  return <div className={'task-detail detail-' + detail}>
    <nav className="detail-tabs" aria-label="Working detail">
      {(['source', 'processing', 'block', 'graph', 'modulation', 'capture'] as const).map(key => <button key={key} aria-pressed={detail === key} onClick={() => openDeskDetail(key)}>
        {{ source: 'Source range', processing: 'Processing', block: 'Block timing', graph: 'Routing', modulation: 'Modulation', capture: 'Previews' }[key]}</button>)}
      {!animation && detail !== 'processing' && <button className="compact-sequence-return" onClick={() => openDeskDetail('processing')}>Full sequence</button>}
      {animation && detail !== 'processing' && <span className="curve-return">Curve retained <button disabled={!curveNode} title="Return to the retained parameter curve without seeking or changing transport" onClick={() => { if (!curveBlock || !curveNode) return; selectBlock(curveBlock.id); focusAnimation(curveBlock.id, curveNode.id, animation.key); }}>Resume curve</button></span>}
    </nav>
    {detail === 'source' && <SourceDesk which={source} />}
    {detail === 'processing' && <div className="processing-summary"><span className="dim">{block ? 'Applied effects and parameters stay in the inspector.' : 'Mark a source range and add a block to begin.'}</span><button disabled={!block} onClick={() => openDeskDetail('graph')}>Graph / routing</button></div>}
    {detail === 'block' && <BlockPane />}
    {detail === 'graph' && <><div className="detail-actions"><button onClick={() => setWs('node')}>Open full graph</button><span className="dim">Selected block wiring</span></div><div className="task-routing"><GraphCanvas fitOnResize /></div></>}
    {detail === 'modulation' && <LfoPane />}
    {detail === 'capture' && <><section className="task-capture" aria-label="Capture Edit preview"><strong>Capture Edit preview</strong><PreviewSelection /></section><RenderPane /></>}
  </div>;
}
