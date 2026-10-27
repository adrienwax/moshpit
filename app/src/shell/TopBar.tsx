import { useState } from 'react';
import { setUi, setWs, toggleSettings, useUi, WS_LABEL, type WsId } from '../state/ui';
import { stepHistory, useCanRedo, useHistory } from '../state/project';
import { startTour } from '../state/tour';
import { applySaved, deleteSaved, resetWsLayout, saveLayout, useLayouts } from '../layout/model';
import { onDisk } from '../host';
import { ConformPill, ProjectMenu, ProjectIdentity } from './ProjectMenu';
import { confirmAction, toast } from '../qol/qol';
import { engineKind } from '../engine';
import { Icon, type IconName } from '../components/Icon';
import { ScopesInline } from './Scopes';
import { SystemInstruments } from './StatusStrip';
import { CommandMenu } from './CommandMenu';
import { DeskTools } from '../ws/mosh/TaskDesk';
import './command-shell.css';

const WSNAMES: Record<WsId, [string, string]> = {
  home: ['⌂', 'Home'],
  browse: ['▤', 'In'],
  mosh: ['◧', 'Mosh'],
  node: ['◆', 'Graph'],
  render: ['⤓', 'Out'],
  settings: ['⚙', 'Settings'],
};

/** The workflow sequence, with the detailed Graph editor directly accessible. */
const SEQ: { ws: WsId; key: string; hint: string; icon: IconName; step: string }[] = [
  { ws: 'browse', step: '①', icon: 'source', key: 'Alt+1', hint: 'Find, preview, slice and import footage' },
  { ws: 'mosh', step: '②', icon: 'mosh', key: 'Alt+2', hint: 'Arrange blocks and mosh them; Open Graph on a block for its node graph' },
  { ws: 'render', step: '③', icon: 'render', key: 'Alt+3', hint: 'Export jobs and the render queue' },
];

export function TopBar() {
  const ws = useUi((s) => s.ws);
  const canUndo = useHistory().length > 0, canRedo = useCanRedo();
  const current = ws;
  const historyOpen = useUi((s) => s.historyOpen);

  return <header className="topbar command-shell">
    <div className="command-row">
      <div className="brand"><span className="dot" aria-hidden /><b>Moshpit</b><span className="ver">KRAB v1.0</span></div>
      <nav className="global-commands" aria-label="Application commands">
        <ProjectMenu />
        <CommandMenu label="Edit">
          <button data-command disabled={!canUndo} onClick={() => stepHistory(true)}>Undo <kbd>Ctrl+Z</kbd></button>
          <button data-command disabled={!canRedo} onClick={() => stepHistory(false)}>Redo <kbd>Ctrl+Shift+Z</kbd></button>
          <button data-command aria-pressed={historyOpen} onClick={() => setUi({ historyOpen: !historyOpen })}>History</button>
        </CommandMenu>
        <LayoutMenu />
        <CommandMenu label="Help">
          <button data-command onClick={() => startTour()}>Show me around</button>
          <button data-command onClick={() => setWs('home')}>Start / keyboard guide</button>
        </CommandMenu>
        <div className="history-controls" role="group" aria-label="Edit history">
          <button className="ghostbtn" disabled={!canUndo} onClick={() => stepHistory(true)} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
          <button className="ghostbtn" disabled={!canRedo} onClick={() => stepHistory(false)} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" /></button>
        </div>
      </nav>
      <ProjectIdentity />
      <div className="topbar-scopes" id="source-scope-host" hidden={ws !== 'browse'} aria-label="Source scopes" />
      {ws !== 'browse' && <div className="topbar-scopes"><ScopesInline /></div>}
      <SystemInstruments /><ConformPill />
      {engineKind === 'mock' ? <span className="pill mock" title="Mock engine: generated frames, no exports"><span className="lamp" />mock</span> : <span className="engine-indicator" aria-label="Render engine" title="Render engine: WebCodecs and WebGL2 worker"><span className="lamp" /></span>}
    </div>
    <div className="workspace-row">
      <button className={'ghostbtn homebtn' + (ws === 'home' ? ' on' : '')} onClick={() => setWs('home')} title="Home (Alt+0)" aria-label="Home" aria-current={ws === 'home' ? 'page' : undefined}><Icon name="home" /></button>
      <nav className="wsswitch" aria-label="Workspaces">
        {SEQ.map(x => <button key={x.ws} className={current === x.ws || (x.ws === 'mosh' && ws === 'node') ? 'on' : ''} aria-current={current === x.ws ? 'page' : undefined} onClick={() => setWs(x.ws)} title={x.hint + ' (' + x.key + ')'}><Icon name={x.icon} />{WS_LABEL[x.ws]} <span className="k">{x.key}</span></button>)}
      </nav>
      {ws === 'mosh' && <DeskTools />}
      {ws === 'node' && <nav className="context-commands" aria-label="Graph tools"><button onClick={() => setWs('mosh')}>Back to MOSH <kbd>Alt+G</kbd></button></nav>}
      {ws === 'browse' && <span className="workspace-context">Choose footage · mark a range · add to the edit</span>}
      {ws === 'render' && <span className="workspace-context">Export settings and jobs</span>}
    </div>
  </header>;
}

function LayoutMenu() {
  const [name, setName] = useState('');
  const ws = useUi((s) => s.ws);
  const saved = useLayouts((s) => s.saved);
  // F4 (UX round 2): the name box keeps the layout you last saved or loaded, so Save again
  // overwrites it (after a confirm) instead of spawning "My layout 2" from an emptied box.
  const target = name.trim();
  const exists = !!target && saved.some((l) => l.name === target);
  const save = async () => {
    let n = target;
    if (!n) { let i = saved.length + 1; while (saved.some((l) => l.name === `My layout ${i}`)) i++; n = `My layout ${i}`; }
    if (saved.some((l) => l.name === n) && !(await confirmAction(`Replace "${n}"?`, `Saves the current ${WSNAMES[ws][1]} layout over the saved one with this name.`, 'Replace'))) return;
    saveLayout(n, ws);
    setName(n);
    toast(`Layout "${n}" saved ${onDisk ? 'to disk' : 'in this browser'}`, { kind: 'ok' });
  };

  return <CommandMenu label="View">
    <button data-command onClick={toggleSettings}>Settings</button>
    <h6>Workspaces</h6>
    {(Object.keys(WSNAMES) as WsId[]).map(k => <button data-command key={k} aria-current={k === ws ? 'page' : undefined} onClick={() => setWs(k)}><span>{WSNAMES[k][0]} {WSNAMES[k][1]}</span></button>)}
    <h6>Saved layouts</h6>
    {saved.length ? saved.map(l => <div className="saved-layout-row" key={l.name}>
      <button data-command onClick={() => { setWs(l.ws); applySaved(l); setName(l.name); }}>{l.name} <small>({WSNAMES[l.ws][1]})</small></button>
      <button className="delete-layout" aria-label={'Delete layout ' + l.name} onClick={() => { void confirmAction('Delete layout?', l.name, 'Delete').then(ok => { if (ok) deleteSaved(l.name); }); }}>×</button>
    </div>) : <p>No saved layouts</p>}
    <label className="layout-name">Layout name<input value={name} placeholder={'My ' + WSNAMES[ws][1] + ' layout'} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} /></label>
    <button onClick={() => void save()}>{exists ? 'Save over “' + target + '”' : 'Save layout'}</button>
    <button data-command onClick={() => { saveLayout('Before reset ' + new Date().toISOString(), ws); resetWsLayout(ws); toast('Layout reset; previous layout kept in View'); }}>Reset current layout</button>
    <p>{onDisk ? 'Layouts saved in user config' : 'Layouts saved in this browser'}</p>
  </CommandMenu>;
}
