import { useState } from 'react';
import { InfoPane } from '../../qol/InfoPane';
import { Workspace, type PaneDef } from '../../layout/Workspace';
import type { BlockId } from '@moshpit/engine';
import { Inspector, NodeViewer, OutputPreview, blockName, useActive } from '../../components/nodes';
import { setWs } from '../../state/ui';
import { CanvasLegends, GraphCanvas } from './GraphCanvas';
import { LfoPane, LibDragGhost, MiniTimeline, NodeLibrary } from './NodePanes';
import { useSticky } from '../../state/store';
import { selectBlock } from '../../state/project';
import { ProgramPane } from '../mosh/ComposePanes';
import { CompositionCanvas } from './CompositionCanvas';
import './composition-workspace.css';

const PANES: Record<string, PaneDef> = {
  nodelib: { title: 'Node library', help: 'Every node the runtime can execute, by category. Click to add at the canvas centre, or drag onto the canvas.', body: () => <NodeLibrary /> },
  canvas: {
    title: 'Node canvas',
    built: 'active block only',
    help: 'The active block\'s graph. Node categories are colour-coded; ports and wires are typed (encoded · image · mask · number). One wire per input; cycles only through a Delay. Drag params on a node to edit them.',
    body: () => (
      <div className="canvaspane">
        <GraphCanvas />
        <CanvasLegends />
      </div>
    ),
  },
  mini: { title: 'Mini timeline', help: 'Context only: the playhead and the block whose graph is open. Click a block to switch graphs; arrange in MOSH.', body: () => <MiniTimeline /> },
  lfo: { title: 'Project LFOs', built: 'project scope', help: 'Global modulators. An LFO keeps its phase across every block\'s graph because its clock is the timeline (L8).', extra: <span className="hdnote gold">♪ periods in bars/beats</span>, body: () => <LfoPane /> },
  nodeviewer: { title: 'Node viewer', help: 'The output of the node flagged with ◉ — the picture at that point in the chain, not the final render.', extra: <span className="scopetag view">◉ this node</span>, body: () => <NodeViewer /> },
  output: { title: 'Preview', built: 'final output', help: 'The whole timeline\'s output at the playhead. Bitstream ops preview as ≈ proxies; the export is exact.', body: () => <OutputPreview /> },
  ninspector: { title: 'Inspector', help: 'The selected node\'s parameters. Same values as the on-node sliders.', body: () => <Inspector /> },
};

/** Composition and block detail share the same project, selection and effect controls. */
export function NodeWs() {
  const { block, blockIndex } = useActive();
  const [level, setLevel] = useSticky<'composition' | 'block'>('graph.level', 'composition');
  const [expanded, setExpanded] = useState(false);
  const openBlock = (id: BlockId) => { selectBlock(id); setLevel('block'); };
  const controls = <div className="graphbar" role="toolbar" aria-label="Graph view">
    <button className="backbtn" onClick={() => setWs('mosh')} title="Return to MOSH (Alt+2)">‹ MOSH</button>
    <div className="graph-levels" role="group" aria-label="Graph level">
      <button className={level === 'composition' ? 'on' : ''} aria-pressed={level === 'composition'} onClick={() => setLevel('composition')}>{level === 'block' ? 'Return to overview' : 'Edit overview'}</button>
      <button className={level === 'block' ? 'on' : ''} aria-pressed={level === 'block'} disabled={!block} onClick={() => setLevel('block')}>Focus: block wiring</button>
    </div>
    {level === 'composition' && <button className="ghostbtn" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Return to preview' : 'Expand overview'}</button>}
    <span className="gblock">{block ? blockName(block, blockIndex) : 'Select a block'}</span>
  </div>;
  return <div className="graphmode">
    {level === 'composition' ? <div className={'focused-graph-workspace' + (expanded ? ' expanded-overview' : '')}>
      <aside className="focused-graph-library"><header>Node library</header><div className="focused-graph-library-content"><NodeLibrary /></div><InfoPane /></aside>
      <main className="focused-graph-main">
        <section className="focused-graph-preview"><header>Edit preview</header><ProgramPane exportView /></section>
        {controls}
        <div className="focused-graph-canvas"><CompositionCanvas onOpenBlock={openBlock} /></div>
      </main>
      <aside className="composition-inspector" aria-label="Composition inspector">
        <section className="composition-node-preview"><header>Selected node preview</header><NodeViewer /></section>
        <section className="composition-node-controls"><header>Selected effect</header><Inspector onOpenGraph={() => setLevel('block')} /></section>
      </aside>
    </div> : <>{controls}<Workspace ws="node" panes={PANES} /><LibDragGhost /></>}
  </div>;
}
