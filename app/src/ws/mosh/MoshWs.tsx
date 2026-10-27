import { Workspace, type PaneDef } from '../../layout/Workspace';
import { LibraryStrip } from '../browse/BrowsePanes';
import { NodeViewer, useActive } from '../../components/nodes';
import { setUi, setWs } from '../../state/ui';
import { ClipsPane, EditTimeline } from './MoshPanes';
import { FxPanel } from './EffectBrowser';
import { BlockPane, EffectsPane, ProgramPane, RenderPane, SlotsPane, SnapPick, useSlotKeys, ModeToggle } from './ComposePanes';
import { WorkingDetail } from './TaskDesk';
import { useUi } from '../../state/ui';
import './task-desk.css';
import { GraphCanvas } from '../node/GraphCanvas';

// MOSH keeps source navigation left, the docked monitor and edit timeline central, selected properties right.
// Existing panes remain dockable; Arrange/Process changes sizing without replacing saved layouts.
/** The graph header's Add effect: like the Effects pane's, it needs a block and says so. */
function AddEffectButton() {
  const { block } = useActive();
  return (
    <button className="pop" disabled={!block} onClick={() => setUi({ fxPanel: true })} title={block ? 'Search every effect and add it to the selected block' : 'Select a block on the arrangement first: effects are added to one block'}>＋ Add effect</button>
  );
}

const PANES: Record<string, PaneDef> = {
  slots: { title: 'Sources · A / B', help: 'The two clips you are cutting from, A over B. Click one to slice it: I / O mark, J / K / L shuttle, , . step, ⤓ block adds its IN→OUT to the arrangement.', extra: <SnapPick />, body: () => <SlotsPane /> },
  clips: { title: 'Clips', help: "The project's clips. Click: show in slot A · Shift-click: slot B · right-click for more.", body: () => <ClipsPane /> },
  library: { title: 'Library', help: 'The IN library without leaving MOSH. A raw clip is marked in IN, then sent here.', body: () => <LibraryStrip /> },
  program: { title: 'Edit preview', help: 'PROGRAM — the final output at the playhead, after every block and graph. The one monitor that shows the result.', extra: <button className="ghostbtn" onClick={() => setWs('node')}>Open graph</button>, body: () => <ProgramPane /> },
  graph: {
    title: 'Node graph', minor: true,
    help: "The selected block's effect chain. Its CONTEXT preview (right) shows the picture at the selected node — a point inside the chain, not the final output.",
    extra: (
      <>
        <AddEffectButton />
        <button className="ghostbtn" onClick={() => setWs('node')} title="The graph full screen, with the node library and LFOs (Alt+G)">⤢ Full screen</button>
      </>
    ),
    body: () => (
      <div className="canvaspane ctxsplit">
        <div className="gwrap"><GraphCanvas fitOnResize /></div>
        <section className="ctxpv" aria-label="Context preview"><NodeViewer /></section>
      </div>
    ),
  },
  block: { title: 'Block', minor: true, help: 'The selected block as an info sheet: source and clip ranges, frames, rate; trim, playback, kind, repeat; block actions and audio.', body: () => <BlockPane /> },
  effects: { title: 'Applied effects & parameters', help: "The selected block's applied chain and complete effect controls. Add opens the catalogue explicitly.", body: () => <EffectsPane /> },
  detail: { title: 'Working detail', minor: true, body: () => <WorkingDetail /> },
  edit: { title: 'Edit timeline', extra: <ComposeModes />, help: 'The blocks in order. Click to select (the graph and inspector follow), drag to reorder, drag an edge to trim, right-click for more, Delete removes. Wheel zooms, the bar below navigates.', body: () => <EditTimeline /> },
  render: { title: 'Previews & export', minor: true, help: 'Replay earlier captures, compare a reference, or export. Full settings and the queue are in the Render workspace.', body: () => <RenderPane /> },
};
function ComposeModes() { return <ModeToggle known={Object.keys(PANES)} />; }

export function MoshWs() {
  const animation = useUi(s => !!s.animation);
  useSlotKeys(); // Keep source keyboard controls available when Sources is a secondary tab.
  return (
    <div className={'composews task-desk' + (animation ? ' animating' : '')}>
      <Workspace ws="mosh" panes={PANES} />
      <FxPanel />
    </div>
  );
}
