// HOME: where a session starts and where you come back to orient. Layout Law, left → right:
// LEFT start (new / open / continue, then your folders) · CENTRE the work (recent projects, then
// the workspaces with their live state) · RIGHT the machine (build, engine, GPU, CT, session).
import { useEffect, useState } from 'react';
import { APP_LABEL } from '../../../version';
import { Workspace, type PaneDef } from '../../layout/Workspace';
import { Icon, type IconName } from '../../components/Icon';
import { StarterMoshButton } from '../../components/StarterMoshButton';
import { CellThumb } from '../../components/RawPreview';
import { Empty, Loading } from '../../qol/qol';
import { desktop, newProject, openProject, peekProject, recents, save, useDirty, useLife } from '../../state/lifecycle';
import { projectStore, useProject } from '../../state/project';
import { setSettings, setUi, setWs, useSettings, useUi, type WsId } from '../../state/ui';
import { useRenders } from '../../state/render';
import { useHud } from '../../state/telemetry';
import { useControlHostLabel } from '../../state/controlStatus';
import { engineKind } from '../../engine';
import { timelineFrames } from '../../lib/timeline';
import { fpsValue } from '../../lib/time';
import { projectFileStem } from '../../lib/projectFiles';
import type { ProjectPeek } from '../../host';

// From HOME, a project that actually opened (or a new one actually started) takes you to work on it;
// a cancelled dialog leaves you here.
async function openThen(f?: string) {
  const before = projectStore.get().doc;
  await openProject(f);
  if (projectStore.get().doc !== before) setWs('mosh');
}
async function newThen() {
  const before = projectStore.get().doc;
  await newProject();
  if (projectStore.get().doc !== before) setWs('browse');
}

const nameOf = (p: string) => p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || p;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

// ---------- LEFT: start ----------

function StartPane() {
  const name = useProject((d) => d.name);
  const blocks = useProject((d) => d.timeline.blocks.length);
  const file = useLife((s) => s.file);
  const dirty = useDirty();
  const onDesk = desktop();
  const started = blocks > 0 || !!file;
  return (
    <div className="hstart">
      <StarterMoshButton home />
      {started && (
        <button className="hact hpop" onClick={() => setWs('mosh')} title="Back to the open project in MOSH (Alt+2)">
          <Icon name="mosh" size={20} /><span><b>Continue</b><i>{name}{dirty ? ' · unsaved' : ''}</i></span>
        </button>
      )}
      <button className={'hact' + (started ? '' : ' hpop')} onClick={() => void newThen()} title="Start an empty project, then find footage (Ctrl+N)">
        <Icon name="add" size={20} /><span><b>New project</b><i>Ctrl+N</i></span>
      </button>
      <button className="hact" disabled={!onDesk} onClick={() => void openThen()} title={onDesk ? 'Open a project file (Ctrl+O)' : 'Open needs the desktop app'}>
        <Icon name="folder" size={20} /><span><b>Open…</b><i>Ctrl+O</i></span>
      </button>
      <button className="hact" onClick={() => setWs('browse')} title="Browse footage and bring clips in (Alt+1)">
        <Icon name="import" size={20} /><span><b>Find footage</b><i>Source · Alt+1</i></span>
      </button>
      {dirty && onDesk && (
        <button className="hact" onClick={() => void save()} title="Save the open project (Ctrl+S)">
          <Icon name="save" size={20} /><span><b>Save</b><i>{file ? nameOf(file) : 'choose a file'}</i></span>
        </button>
      )}
    </div>
  );
}

function PlacesHome() {
  const favs = useSettings((s) => s.favourites);
  const rec = useSettings((s) => s.recentFolders);
  const go = (f: string) => (setUi({ folder: f }), setWs('browse'));
  const row = (f: string, fav: boolean) => (
    <button key={(fav ? 'f' : 'r') + f} className="hplace" onClick={() => go(f)} title={`Open in IN: ${f}`}>
      <Icon name="folder" size={14} /><span className="pn">{nameOf(f)}</span>{fav && <span className="pstar" aria-label="favourite">★</span>}
    </button>
  );
  if (!favs.length && !rec.length) return <Empty icon="★" title="No folders yet">Folders you open in IN land here; star one to pin it.</Empty>;
  return (
    <div className="hplaces">
      {favs.map((f) => row(f, true))}
      {rec.filter((f) => !favs.includes(f)).map((f) => row(f, false))}
    </div>
  );
}
const PlacesCount = () => <span className="accstate">{useSettings((s) => s.favourites.length)} ★ · {useSettings((s) => s.recentFolders.length)} recent</span>;

// ---------- CENTRE: recent projects ----------

function useRecentPeeks() {
  const file = useLife((s) => s.file);
  const [peeks, setPeeks] = useState<ProjectPeek[] | null>(null);
  useEffect(() => {
    let live = true;
    void recents().then((list) => Promise.all(list.slice(0, 8).map(peekProject))).then((p) => live && setPeeks(p));
    return () => void (live = false);
  }, [file]);
  return peeks;
}

function ProjectsPane() {
  const peeks = useRecentPeeks();
  const file = useLife((s) => s.file);
  const dirty = useDirty();
  if (!desktop()) return <Empty icon="▦" title="Recent projects need the desktop app" />;
  if (!peeks) return <Loading>Reading recent projects…</Loading>;
  if (!peeks.length) return <Empty icon="▦" title="No recent projects" cta={{ label: 'New project', run: () => void newThen() }}>Projects you save or open show here with a picture of their first block.</Empty>;
  return (
    <div className="hprojects">
      {peeks.map((p) => {
        const cur = p.file === file;
        if (p.error !== undefined) {
          return (
            <div key={p.file} className="hcard bad" title={p.file}>
              <div className="hthumb"><span className="hnothumb">⚠</span></div>
              <div className="hcmeta"><b>{nameOf(p.file)}</b><i className="warn">could not read: {p.error}</i></div>
            </div>
          );
        }
        return (
          <button key={p.file} className={'hcard' + (cur ? ' cur' : '')} onClick={() => (cur && !dirty ? setWs('mosh') : void openThen(p.file))} title={`${p.file}${cur ? ' — open now' : ''}. Click to open in MOSH; move along the picture to scrub its first clip.`}>
            <div className="hthumb">{p.thumb ? <CellThumb path={p.thumb.path} durationSec={Math.max(1, p.thumb.timeSec * 2)} /> : <span className="hnothumb"><Icon name="source" size={28} /></span>}{cur && <span className="hcur">OPEN</span>}{p.missing > 0 && <span className="hmiss" title={`${p.missing} source file(s) not found`}>{p.missing} missing</span>}</div>
            <div className="hcmeta">
              <b>{p.name}</b>
              <span className="hro"><i>BLK</i>{p.blocks}<i>CLIPS</i>{p.clips}<i>LEN</i>{mmss(p.seconds)}<i>BPM</i>{p.bpm}</span>
              <i className="dim">{ago(p.mtimeMs)} · {projectFileStem(p.file)}</i>
            </div>
          </button>
        );
      })}
    </div>
  );
}
const ProjectsCount = () => {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => void recents().then((l) => setN(l.length)), []);
  return <span className="accstate">{n == null ? '…' : `${n} recent`}</span>;
};

// ---------- CENTRE: jump to a workspace, with its live state ----------

function JumpPane() {
  const clips = useProject((d) => d.resources.sources.length);
  const blocks = useProject((d) => d.timeline.blocks);
  const fps = useProject((d) => d.settings.fps);
  const folder = useUi((s) => s.folder);
  const jobs = useRenders();
  const running = jobs.find((j) => j.status === 'rendering');
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const tiles: { ws: WsId; icon: IconName; label: string; key: string; state: string }[] = [
    { ws: 'browse', icon: 'source', label: 'In', key: 'Alt+1', state: `${clips} clip${clips === 1 ? '' : 's'} in · ${folder ? nameOf(folder) : 'no folder yet'}` },
    { ws: 'mosh', icon: 'mosh', label: 'Mosh', key: 'Alt+2', state: `${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${mmss(timelineFrames(blocks) / fpsValue(fps))}` },
    { ws: 'node', icon: 'node', label: 'Graph', key: 'Alt+G', state: blocks.length ? 'the selected block' : 'needs a block' },
    { ws: 'render', icon: 'render', label: 'Out', key: 'Alt+3', state: running ? `rendering ${Math.round(running.fraction * 100)}%` : queued ? `${queued} queued` : 'idle' },
  ];
  return (
    <div className="hjump">
      {tiles.map((t) => (
        <button key={t.ws} className="htile" onClick={() => setWs(t.ws)} disabled={t.ws === 'node' && !blocks.length} title={`${t.label} (${t.key})`}>
          <Icon name={t.icon} size={28} />
          <span className="htl"><b>{t.label}</b><span className="k">{t.key}</span></span>
          <i>{t.state}</i>
        </button>
      ))}
    </div>
  );
}

// ---------- RIGHT: the machine ----------

const electronVersion = () => /Electron\/([\d.]+)/.exec(navigator.userAgent)?.[1];
const gb = (mb: number) => (mb / 1024).toFixed(1);
const size = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`);

function SystemPane() {
  const t = useHud((s) => s.t);
  const ct = useControlHostLabel();
  const g = t?.gpu;
  const rows: { icon: IconName; k: string; v: string; cls?: string; title?: string }[] = [
    { icon: 'home', k: 'BUILD', v: `${APP_LABEL}${electronVersion() ? ` · Electron ${electronVersion()}` : ' · browser dev'}` },
    { icon: 'effect', k: 'ENGINE', v: engineKind === 'mock' ? 'mock (no renders)' : 'real · WebCodecs + WebGL2', cls: engineKind === 'mock' ? 'warn' : 'ok' },
    { icon: 'gpu', k: 'GPU', v: g ? `${Math.round(g.load * 100)}% · ${g.name.replace(/^NVIDIA /, '')}` : 'n/a', title: 'nvidia-smi, every 2 s' },
    { icon: 'vram', k: 'VRAM', v: g ? `${gb(g.vramUsedMB)} / ${gb(g.vramTotalMB)} GB (machine)` : 'n/a' },
    { icon: 'cache', k: 'CACHE', v: t?.cacheBytes != null ? `${size(t.cacheBytes)} · engine-cache` : '—' },
    { icon: 'ct-link', k: 'CT LINK', v: ct.short, cls: ct.ready ? 'ok' : '', title: ct.detail },
  ];
  return (
    <div className="hsys">
      {rows.map((r) => (
        <div key={r.k} className={'hsrow ' + (r.cls ?? '')} title={r.title}>
          <Icon name={r.icon} size={16} /><i>{r.k}</i><b>{r.v}</b>
        </div>
      ))}
    </div>
  );
}
const SysState = () => { const ct = useControlHostLabel(); return <span className="accstate" title={ct.detail}>{ct.short}</span>; }

function SessionPane() {
  const file = useLife((s) => s.file);
  const dirty = useDirty();
  const autosave = useSettings((s) => s.autosaveMin);
  const startHome = useSettings((s) => s.startOn !== 'compose');
  return (
    <div className="hsys">
      <div className={'hsrow ' + (dirty ? 'warn' : 'ok')}><Icon name="save" size={16} /><i>STATE</i><b>{file ? (dirty ? 'unsaved edits' : 'saved') : 'not saved yet'}</b></div>
      <div className="hsrow" title={file ?? ''}><Icon name="folder" size={16} /><i>FILE</i><b>{file ? nameOf(file) : '—'}</b></div>
      <div className="hsrow"><Icon name="undo" size={16} /><i>SAFETY</i><b>{autosave > 0 ? 'every edit journaled · crash recovery on' : 'autosave off: only Save keeps edits'}</b></div>
      <label className="hsrow hchk" title="Which workspace Moshpit opens on">
        <Icon name="home" size={16} /><i>START ON</i>
        <b><input type="checkbox" checked={startHome} onChange={(e) => setSettings((s) => void (s.startOn = e.target.checked ? 'home' : 'compose'))} /> Home</b>
      </label>
    </div>
  );
}

function KeysPane() {
  const keys: [string, string][] = [
    ['Alt+0 1 2 3', 'Home · Source · Compose · Render'],
    ['Alt+G', 'Graph of the selected block'],
    ['Space', 'Play / stop'],
    ['J K L', 'Shuttle reverse · stop · forward'],
    [', .', 'Step one frame / beat / bar'],
    ['I O', 'Mark IN / OUT'],
    ['Ctrl+S O N', 'Save · Open · New'],
    ['Ctrl+Z', 'Undo (Shift: redo)'],
  ];
  return <div className="hkeys">{keys.map(([k, v]) => <div key={k}><kbd>{k}</kbd><span>{v}</span></div>)}</div>;
}

const PANES: Record<string, PaneDef> = {
  hstart: { title: 'Start', help: 'Continue the open project, start a new one, open a file, or go find footage.', body: () => <StartPane /> },
  hplaces: { title: 'Folders', help: 'Your IN favourites (★) and the folders you opened last. Click to open one in IN.', extra: <PlacesCount />, body: () => <PlacesHome /> },
  hprojects: { title: 'Recent projects', help: 'The last projects you saved or opened, each with a picture of its first clip (move along it to scrub). Click to open in MOSH.', extra: <ProjectsCount />, body: () => <ProjectsPane /> },
  hjump: { title: 'Workspaces', help: 'Each workspace with what is in it right now.', body: () => <JumpPane /> },
  hsys: { title: 'System', help: 'This build, the render engine, the GPU and cache readouts, and the CT control link.', extra: <SysState />, body: () => <SystemPane /> },
  hsession: { title: 'Session', help: 'The open project: saved or not, its file, and how it is kept safe.', body: () => <SessionPane /> },
  hkeys: { title: 'Keys', help: 'The shortcuts that work everywhere.', body: () => <KeysPane /> },
};

export function HomeWs() {
  return <Workspace ws="home" panes={PANES} />;
}
