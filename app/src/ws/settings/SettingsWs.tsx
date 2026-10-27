// Settings: modular prefs in three scopes (L13). App + User/app write the on-disk settings file;
// Project rows edit the project document (undoable, saved with the project).
import type { ReactNode } from 'react';
import { APP_LABEL, APP_VERSION } from '../../../version';
import { Workspace, type PaneDef } from '../../layout/Workspace';
import { setSettings, setUi, useSettings, useSettingsSave, flushSettings, useUi, type AppSettings, type ThemeId } from '../../state/ui';
import { FPS_OPTIONS, changeProjectFormat, setSettings as setProjectSettings, useProject } from '../../state/project';
import { ParamControl } from '../../params/Param';
import { host, onDisk } from '../../host';
import { engine } from '../../engine';
import { adoptFolders } from '../browse/BrowsePanes';
import { fmtFps } from '../../lib/time';
import { PROJECT_RESOLUTIONS } from '../../lib/resolutions';
import { toast, toastError } from '../../qol/qol';
import { startTour } from '../../state/tour';
import { useHud } from '../../state/telemetry';
import { useEffect, useState } from 'react';
import { overlaps } from '@moshpit/engine';

type Scope = 'app' | 'user' | 'project';
interface Section {
  id: string;
  scope: Scope;
  title: string;
  rows: () => ReactNode;
}

// The swatch is the theme itself: each card carries data-theme, so it paints with that theme's
// tokens (design.css) — interactive, commit, transient, valid — and holds no hex of its own.
const THEMES: { k: ThemeId; name: string; desc: string }[] = [
  { k: 'hud', name: 'HUD', desc: 'Default — cyan builds and selects, crimson commits' },
  { k: 'studio', name: 'Studio', desc: 'Restrained — violet builds and selects, blue commits' },
  { k: 'heritage', name: 'Heritage', desc: 'Mœbius lineage — coral builds and selects, lime commits' },
];
const SWATCH = ['--fn-interactive', '--fn-commit', '--fn-transient', '--fn-valid'];

function Row({ t, d, children }: { t: string; d?: string; children: ReactNode }) {
  return (
    <div className="setrow">
      <div className="sk"><div className="t">{t}</div>{d && <div className="d">{d}</div>}</div>
      <div className="sv">{children}</div>
    </div>
  );
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: readonly (T | [T, string])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const [v, l]: [T, string] = Array.isArray(o) ? o : [o as T, String(o)];
        return <button key={String(v)} role="radio" aria-checked={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>;
      })}
    </div>
  );
}

// E14: a media-root change rescans the library at once and replaces Source's cached tree (B2).
let appliedRoots: string | undefined;
let rootsRequest = 0;
async function applyMediaRoots(v: string, force = false) {
  if (!force && v === appliedRoots) return;
  const request = ++rootsRequest;
  try {
    const folders = await engine.setLibraryRoots(v.split(';'));
    if (request !== rootsRequest) return;
    appliedRoots = v;
    adoptFolders(folders);
    toast(`Library rescanned: ${folders.length} root${folders.length === 1 ? '' : 's'} found`);
  } catch (error) { if (request === rootsRequest) toastError(error); }
}

/**
 * Phase 0.4: Moshpit's cache never sits inside a media root (or holds one): it is refused here, and
 * main falls back to the profile. The render output is allowed there, with a note that renders
 * will then show up in the library.
 */
function overlapNote(k: keyof AppSettings['paths'], v: string, media: string): { level: 'err' | 'warn'; text: string } | null {
  if (!v.trim() || (k !== 'cache' && k !== 'output')) return null;
  const root = media.split(';').map((r) => r.trim()).find((r) => r && overlaps(v, r));
  if (!root) return null;
  return k === 'output'
    ? { level: 'warn', text: `Inside the media root ${root}: renders will show up in the library as clips.` }
    : { level: 'err', text: `Overlaps the media root ${root}. Moshpit keeps its own files apart from your footage, so this folder is not used; pick one outside it.` };
}

function PathRow({ k, t, d, placeholder }: { k: keyof AppSettings['paths']; t: string; d: string; placeholder?: string }) {
  const v = useSettings((s) => s.paths[k]);
  const media = useSettings((s) => s.paths.media);
  const cache = useSettings((s) => s.paths.cache);
  const [draft, setDraft] = useState(v);
  const [scanning, setScanning] = useState(false);
  useEffect(() => setDraft(v), [v]);
  const validatePath = (value: string) => k === 'media'
    ? overlapNote('cache', cache, value)
    : overlapNote(k, value, media);
  const note = validatePath(draft);
  const scan = async (value: string, force = false) => {
    setScanning(true);
    try { await applyMediaRoots(value, force); } finally { setScanning(false); }
  };
  const commit = (force = false) => {
    if (note?.level === 'err') { toast(note.text, { kind: 'warn' }); return; }
    if (draft !== v) setSettings((s) => void (s.paths[k] = draft.trim()));
    if (k === 'media' && (draft.trim() !== v || force)) void scan(draft.trim(), force);
  };
  // Media root(s) holds several folders: a picked one replaces the first and keeps the rest.
  const pick = async () => {
    const roots = v.split(';').map((r) => r.trim()).filter(Boolean);
    const dir = await host.files!.pickFolder(`Choose ${t}`, roots[0]).catch((e) => void toastError(e));
    if (!dir) return;
    const next = k === 'media' ? [dir, ...roots.slice(1)].join(';') : dir;
    const bad = validatePath(next);
    if (bad?.level === 'err') return toast(bad.text, { kind: 'warn' });
    setSettings((s) => void (s.paths[k] = next));
    setDraft(next);
    if (k === 'media') void scan(next);
  };
  return (
    <Row t={t} d={d}>
      <div className="pathinput">
        <input value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={() => commit()} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.stopPropagation(); setDraft(v); } }} aria-label={t} aria-invalid={note?.level === 'err'} spellCheck={false} />
        <button title={host.files ? `Choose the ${t} folder` : 'The folder picker needs the desktop app; type or paste the path'} disabled={!host.files} onClick={() => void pick()}>Browse…</button>
        {k === 'media' && <button disabled={scanning || note?.level === 'err'} onPointerDown={e => e.preventDefault()} onClick={() => commit(true)}>{scanning ? 'Scanning…' : 'Rescan'}</button>}
      </div>
      {note && <div className={'pathnote ' + note.level} role={note.level === 'err' ? 'alert' : undefined}>{note.level === 'err' ? '⚠ ' : ''}{note.text}</div>}
    </Row>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Alt+1 · 2 · 3', 'IN · MOSH · OUT (Settings: the ⚙ cog)'],
  ['Alt+G', 'Open Graph on the selected block · again to return to MOSH'],
  ['Space', 'Play / pause the timeline'],
  ['J · K · L', 'Shuttle reverse · stop · forward (press again = faster)'],
  [', · .', 'Step one frame / beat / bar back · forward (follows snap)'],
  ['I · O', 'Set IN · OUT at the playhead'],
  ['Ctrl+Z · Ctrl+Shift+Z / Ctrl+Y', 'Undo · Redo'],
  ['Delete / Backspace', 'Delete selected nodes or wires (undoable)'],
  ['Right-click / double-click canvas · hold A', 'Radial Add / Search / View / Layout menu (hold A, flick, release = expert path)'],
  ['Right-drag across wires', 'Highlight connections to cut; release to apply. Esc cancels; one Undo restores the stroke. Left/middle-drag pans.'],
  ['In a radial', '1–6 or the underlined letter · ←/→ + Enter · Backspace / centre / right-click = back · Esc = close'],
  ['Click a value · drag it', 'Type an exact value (Enter sets, Esc cancels) · drag to scrub, Shift fine, Alt coarse · ←→ ↑↓ step (Shift ÷10, Alt ×10) · right-click resets'],
];

const SECTIONS: Section[] = [
  {
    id: 'notes', scope: 'app', title: 'Interaction & guidance',
    rows: () => <NotesRows />,
  },
  {
    id: 'shortcuts', scope: 'app', title: 'Keyboard shortcuts',
    rows: () => <>{SHORTCUTS.map(([k, v]) => <Row key={k} t={k}><span className="setinfo">{v}</span></Row>)}</>,
  },
  {
    id: 'states', scope: 'app', title: 'Help & workflow',
    rows: () => <StatesRows />,
  },
  {
    id: 'about', scope: 'app', title: 'About',
    rows: () => <>
      <Row t="Release"><span className="setinfo">{APP_LABEL}</span></Row>
      <Row t="Version" d="Internal software version"><span className="setinfo">{APP_VERSION}</span></Row>
    </>,
  },
  {
    id: 'folders', scope: 'user', title: 'Folders & paths',
    rows: () => (
      <>
        <PathRow k="media" t="Media root(s)" d="Library folders the engine indexes, ';'-separated. Empty = your Videos folder. Rescans when you leave the field" placeholder="(default: your Videos folder)" />
        <PathRow k="output" t="Render output" d="Default export folder" />
        <PathRow k="cache" t="Cache / proxies" d="Disposable preview and conform cache. Folder changes take effect after restarting Moshpit" />
      </>
    ),
  },
  {
    id: 'defaults', scope: 'user', title: 'Media defaults',
    rows: () => <DefaultsRows />,
  },
  {
    id: 'performance', scope: 'user', title: 'Performance',
    rows: () => <PerfRows />,
  },
  {
    id: 'appearance', scope: 'user', title: 'Appearance',
    rows: () => <AppearanceRows />,
  },
  {
    id: 'format', scope: 'project', title: 'Format & time',
    rows: () => <FormatRows />,
  },
  {
    id: 'colour', scope: 'project', title: 'Colour & determinism',
    rows: () => <ColourRows />,
  },
];

function NotesRows() {
  const on = useSettings((s) => s.annotations);
  const arm = useSettings((s) => s.radial.armMs);
  return (
    <>
      <Row t="Show annotations" d="Outline every pane and show what it does on hover">
        <Seg label="Annotations" value={on ? 'on' : 'off'} options={['on', 'off'] as const} onChange={(v) => setSettings((s) => void (s.annotations = v === 'on'))} />
      </Row>
      <Row t="Radial hold delay" d="How long a held-A gesture waits before release can select an action. A quick tap leaves the menu open">
        <Seg label="Radial hold delay" value={arm} options={[[120, 'Fast · 120 ms'], [200, 'Balanced · 200 ms'], [320, 'Deliberate · 320 ms']]} onChange={(armMs) => setSettings((s) => void (s.radial.armMs = armMs))} />
      </Row>
      <Row t="Graph gestures"><span className="setinfo">Right-click or double-click the background for the radial. Right-drag across wires to cut, Escape to cancel, Undo to restore. Left/middle-drag pans.</span></Row>
      <Row t="Pane help"><span className="setinfo">The ⓘ badge on each pane header explains what it does. Annotations add visible outlines when you want extra guidance.</span></Row>
    </>
  );
}

function StatesRows() {
  return <>
    <Row t="The creative loop"><span className="setinfo">Choose footage in IN, build and compare treatments in MOSH, then export in OUT. Open Graph when you want to change the connections inside a block.</span></Row>
    <Row t="Look or operator?"><span className="setinfo">A look is a reusable network with a few exposed knobs. An operator is one effect. Utilities handle routing, mixing and timing; they may need wiring before they change the picture.</span></Row>
    <Row t="Try before adding"><span className="setinfo">Selecting an effect auditions it without changing the project. Compare against Original, then Apply when you want to keep it. Undo returns to the previous project state.</span></Row>
    <Row t="Stream and picture"><span className="setinfo">Stream effects manipulate encoded motion before Decode. Picture effects process decoded frames. Socket shapes, labels and wire colours show which input each needs.</span></Row>
    <Row t="Approximate preview"><span className="setinfo">≈ means the preview is a proxy for that operation. Check a short export when the exact result matters.</span></Row>
    <Row t="Quick tour"><button onClick={() => { startTour(); setUi({ ws: 'browse' }); }}>Replay the workflow tour</button></Row>
    <Row t="Missing footage"><button onClick={() => setUi({ settingsPage: 'folders' })}>Check media folders</button></Row>
  </>;
}

function DefaultsRows() {
  const d = useSettings((s) => s.defaults);
  const set = (p: Partial<AppSettings['defaults']>) => setSettings((s) => void Object.assign(s.defaults, p));
  return (
    <>
      <Row t="Default codec" d="New projects only; existing exports keep their settings"><Seg label="Codec" value={d.codec} options={['HAP', 'ProRes', 'H.264'] as const} onChange={(codec) => set({ codec })} /></Row>
      <Row t="Default resolution" d="Working and export size for new projects"><Seg label="Resolution" value={d.resolution} options={PROJECT_RESOLUTIONS.map(s => s.label)} onChange={(resolution) => set({ resolution })} /></Row>
      <Row t="Default fps" d="New projects; mixed-rate clips keep their duration"><Seg label="FPS" value={d.fps} options={['24', '25', '30', '50', '60'] as const} onChange={(fps) => set({ fps })} /></Row>
    </>
  );
}

function PerfRows() {
  const auto = useSettings((s) => s.autosaveMin);
  const live = useSettings((s) => s.liveThumbs);
  const telemetry = useHud((s) => s.t);
  return (
    <>
      <Row t="Autosave" d="Keeps a recovery journal of edits. Explicit Save still writes the project file"><Seg label="Autosave" value={auto > 0 ? 1 : 0} options={[[1, 'every edit'], [0, 'off']] as const} onChange={(v) => setSettings((s) => void (s.autosaveMin = v))} /></Row>
      <ConformCheckRow />
      <Row t="Live effect thumbnails" d="Preview visible effects on your footage; turn off to reduce preview work"><Seg label="Live thumbnails" value={live ? 'on' : 'off'} options={['on', 'off'] as const} onChange={(v) => setSettings((s) => void (s.liveThumbs = v === 'on'))} /></Row>
      <Row t="Render backend"><span className="setinfo">WebGL2 · preview quality does not change your export settings</span></Row>
      <Row t="Cache usage"><span className="setinfo">{telemetry?.cacheBytes == null ? 'Not reported in this session' : `${(telemetry.cacheBytes / 2 ** 30).toFixed(2)} GB`} · disposable renders and previews</span></Row>
    </>
  );
}

function ConformCheckRow() {
  const v = useSettings((s) => s.conformCheck);
  return (
    <Row t="Re-check conforms on open" d="Re-conform clips and compare with their saved record. Can be slow on large projects">
      <Seg label="Re-check conforms" value={v} options={[['ask', 'ask'], ['always', 'always'], ['never', 'never']] as const} onChange={(x) => setSettings((s) => void (s.conformCheck = x))} />
    </Row>
  );
}

function AppearanceRows() {
  const scale = useSettings((s) => s.uiScale);
  const theme = useSettings((s) => s.theme);
  const approx = useSettings((s) => s.approxLabels);
  return (
    <>
      <Row t="UI scale" d="Larger text and controls, or a denser workspace"><Seg label="UI scale" value={scale} options={[[0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%']] as const} onChange={(v) => setSettings((s) => void (s.uiScale = v))} /></Row>
      <Row t="Theme" d="All dark; HUD is the default. Only the accents change: every function keeps its colour role">
        <div className="themerow" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.k} role="radio" aria-checked={t.k === theme} className={'themecard' + (t.k === theme ? ' on' : '')} onClick={() => setSettings((s) => void (s.theme = t.k))} title={t.desc}>
              <div className="tprev" data-theme={t.k} style={{ background: 'var(--surface-1)' }}>{SWATCH.map((v) => <i key={v} style={{ background: `var(${v})` }} />)}</div>
              <div className="tn">{t.name}</div>
            </button>
          ))}
        </div>
      </Row>
      <Row t="≈ labels" d="Mark estimated / proxy frames"><Seg label="Approx labels" value={approx ? 'on' : 'off'} options={['on', 'off'] as const} onChange={(v) => setSettings((s) => void (s.approxLabels = v === 'on'))} /></Row>
    </>
  );
}

function FormatRows() {
  const st = useProject((d) => d.settings);
  const change = (label: string, patch: Partial<typeof st>) => changeProjectFormat(label, patch);
  return (
    <>
      <Row t="Working size" d="Set before importing; clips conform to this size">
        <Seg label="Working size" value={`${st.working.w}×${st.working.h}`} options={PROJECT_RESOLUTIONS.map(s => s.label)} onChange={(v) => { const [w, h] = v.split('×').map(Number); void change(`Working size → ${v}`, { working: { w, h } }); }} />
      </Row>
      <Row t="Frame rate" d="Variable frame-rate footage is conformed on import">
        <Seg label="Frame rate" value={`${st.fps.num}/${st.fps.den}`} options={FPS_OPTIONS.map((f) => [`${f.num}/${f.den}`, fmtFps(f)] as [string, string])} onChange={(v) => { const [num, den] = v.split('/').map(Number); void change(`Frame rate → ${fmtFps({ num, den })}`, { fps: { num, den } }); }} />
      </Row>
      <Row t="Tempo" d="Every beat value follows the project tempo">
        <div style={{ width: 240 }}>
          <ParamControl variant="mini" fieldKey="project|bpm" spec={{ label: 'BPM', type: 'int', min: 60, max: 200, step: 1, default: 124, help: 'Project tempo' }} value={st.bpm} onChange={(v) => setProjectSettings({ bpm: v as number }, `BPM → ${v}`)} />
        </div>
      </Row>
      <Row t="Time display" d="♪⇄s changes the display of an individual field">
        <Seg label="Time display" value={st.timeDisplay} options={[['musical', '♪ bars/beats'], ['seconds', 's seconds']] as const} onChange={(v) => setProjectSettings({ timeDisplay: v }, `Time display → ${v}`)} />
      </Row>
    </>
  );
}

function ColourRows() {
  const st = useProject((d) => d.settings);
  return (
    <>
      <Row t="Working space"><span className="setinfo">Linear-light Rec.709 · RGBA16F intermediates · premultiplied alpha</span></Row>
      <Row t="Output colour"><span className="setinfo">Each export format owns its pixel format, matrix, range and transfer.</span></Row>
      <Row t="Project seed" d="The starting seed for repeatable procedural effects">
        <div style={{ width: 240 }}>
          <ParamControl variant="mini" fieldKey="project|seed" spec={{ label: 'Seed', type: 'int', min: 0, max: 99999, step: 1, default: 4242, help: 'Same seed + same project = same render' }} value={st.seed} onChange={(v) => setProjectSettings({ seed: v as number }, `Seed → ${v}`)} />
        </div>
      </Row>
    </>
  );
}

const SCOPE_LABEL: Record<Scope, string> = { app: 'This app', user: 'This app', project: 'This project' };

function SettingsNav() {
  const page = useUi((s) => s.settingsPage);
  return (
    <nav className="setnav" aria-label="Settings sections">
      {(['app', 'project'] as const).map((sc) => (
        <div key={sc}>
          <div className="scope">{SCOPE_LABEL[sc]}</div>
          {SECTIONS.filter((s) => sc === 'app' ? s.scope !== 'project' : s.scope === 'project').map((s) => (
            <button key={s.id} className={'sitem' + (s.id === page ? ' on' : '')} aria-current={s.id === page} onClick={() => setUi({ settingsPage: s.id })}>{s.title}</button>
          ))}
        </div>
      ))}
      <div className="store2"><i className={onDisk ? '' : 'off'} />{onDisk ? 'User settings are saved to disk' : 'Browser dev mode — settings in browser storage'}</div>
    </nav>
  );
}

function Prefs() {
  const page = useUi((s) => s.settingsPage);
  const save = useSettingsSave();
  const s = SECTIONS.find((x) => x.id === page) ?? SECTIONS[0];
  return (
    <div className="setpanel">
      <div className="sh">
        <h3>{s.title}</h3>
        <span className={'sc ' + (s.scope === 'project' ? 'proj' : 'user')}>{SCOPE_LABEL[s.scope]}</span>
        <span className="dim" style={{ marginLeft: 'auto', fontSize: 10 }}>{s.scope === 'project' ? 'Saved in the project file · undoable' : onDisk ? 'Saved in user config on disk' : 'Saved in browser storage'}</span>
      </div>
      {save.error && <div className="settings-save-error" role="alert">{save.libraryEdit ? 'Preset library change was not saved' : 'Settings have not been saved'}: {save.error}. {save.libraryEdit ? 'Retry from the preset controls.' : <button className="ghostbtn" onClick={() => void flushSettings().catch(() => {})}>Retry saving</button>}</div>}
      <div className="setbody">{s.rows()}</div>
    </div>
  );
}

const PANES: Record<string, PaneDef> = {
  setnav: { title: 'Settings', help: 'App preferences are saved on this machine. Project settings are undoable and saved in the .mosh file.', body: () => <SettingsNav /> },
  prefs: { title: 'Preferences', body: () => <Prefs /> },
};

export function SettingsWs() {
  return <Workspace ws="settings" panes={PANES} />;
}
