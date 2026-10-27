import { sameSourceRange } from '../../lib/sourceRange';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chapter, ConformedSource, SourceClip, SourceId, SourceRange } from '@moshpit/engine';
import { CONFORM_QUALITIES, MoshpitError } from '@moshpit/engine';
import { engine, type LibraryClip, type LibraryFolder, type ImportProgress } from '../../engine';
import { fpsValue, fmtFps, timecode } from '../../lib/time';
import { rawFrames } from '../../lib/frames';
import { addBlock, addSource, canAdoptImport, getDoc, setChapters, useProject } from '../../state/project';
import { setLoupe, setSettings, setUi, setWs, settingsStore, uiStore, useSettings, useUi } from '../../state/ui';
import { ConformBadge } from '../../components/ConformBadge';
import { Icon } from '../../components/Icon';
import { StarterMoshButton } from '../../components/StarterMoshButton';
import { MediaMark, Timecode } from '../../components/MediaReadout';
import './browse.css';
import { CHIPS, visibleClips, visibleFolders, type Sort } from './browseModel';
import { chapterPreviewFrame, chaptersToConform, chaptersToRaw, mergeChapterIds, rawPreviewFrame } from './browseTimebase';
import { cancelJob, dismissJob, runJob, useJob } from '../../state/jobs';
import { FrameView } from '../../components/FrameView';
import { PreviewTransport } from '../../components/PreviewTransport';
import { ViewerViewport } from '../../components/ViewerViewport';
import { SliceTrack } from '../../components/SliceTrack';
import { ParamControl } from '../../params/Param';
import { Empty, ErrorBanner, Loading, choose, confirmAction, toast, toastError } from '../../qol/qol';
import { createElement as h } from 'react';
import { createStore, readSticky, useSticky, useStickyValue, useStore } from '../../state/store';
import { browseReadout, controlFeedback } from '../../state/controlFeedback';
import { RadialPick } from '../../radial/RadialPick';
import { CellThumb, RawFrame, ScopeStrip, measure } from '../../components/RawPreview';
import { pinPreview, previewInfoOf } from '../../state/preview';
import { openContextMenu, type MenuItem } from '../../qol/qol';
import { classify, droppedPaths, folderOf as osFolderOf, isOsDrop, openDropped } from '../../lib/osDrop';
type DirListing = Awaited<ReturnType<typeof engine.listDir>>;
import { host } from '../../host';
import type { ScopeData } from '../../shell/Scopes';
import { browseFrame, createBrowseCommands, dispatchBrowseCommand, registerBrowseControls, selectBrowseClip } from '../../state/browseControl';

// Phase C: the Source browser looks at raw files — hover-scrub, preview, slice marks — with no
// import. Conform runs only when a clip is used (Use → import & conform), as a background job.

/** Drag payload between Source panes: a clip path, or a folder path. */
const DRAG_CLIP = 'application/x-moshpit-clip';
const DRAG_FOLDER = 'application/x-moshpit-folder';

// ---------- library state (one load per folder, shared by every Browse pane) ----------

interface LibState {
  folder?: string;
  clips?: LibraryClip[];
  loading: boolean;
  error?: unknown;
  /** IN marks and session chapters use raw-file frames; project chapters use conform frames. */
  marks: Record<string, { in: number; out: number }>;
  chapters: Record<string, Chapter[]>;
  frame: Record<string, number>;
  /** Audit B2: the tree, its open state and every folder's clips are fetched once per session,
   *  not on every mount. ⟳ (or a media-root change) rescans. */
  folders?: LibraryFolder[];
  foldersErr?: unknown;
  open: Record<string, boolean>;
  byFolder: Record<string, LibraryClip[]>;
  /** Multi-select (v1's "six files, one trip"): picked paths, and the shift-click anchor. */
  picked: string[];
  anchor?: string;
}
const lib = createStore<LibState>({ loading: false, marks: {}, chapters: {}, frame: {}, open: {}, byFolder: {}, picked: [] });

/** Patch one clip wherever it is listed: the open folder and every cached folder (an import can
 *  finish after you moved on, and its folder must still show it as in the project). */
function patchClip(path: string, p: Partial<LibraryClip>) {
  const fix = (l: LibraryClip[]) => l.map((x) => (x.path === path ? { ...x, ...p } : x));
  lib.set((s) => ({ ...s, clips: s.clips && fix(s.clips), byFolder: Object.fromEntries(Object.entries(s.byFolder).map(([k, l]) => [k, fix(l)])) }));
}

async function loadFolders(force = false) {
  if (lib.get().folders && !force) return;
  try {
    const folders = await engine.libraryFolders();
    adoptFolders(folders);
  } catch (foldersErr) {
    lib.set((s) => ({ ...s, foldersErr }));
  }
}

/** A fresh tree (a rescan, or Settings changed the media roots): every cached folder listing goes. */
export function adoptFolders(folders: LibraryFolder[]) {
  const all = (f: LibraryFolder[]): string[] => f.flatMap((x) => [x.path, ...all(x.children)]);
  const cur = uiStore.get().folder;
  // A remembered folder the library no longer has falls back to its first root.
  // Only an empty choice falls back to the first root: navigation opens folders outside the roots too.
  if (folders.length && !cur) setUi({ folder: folders[0].path });
  void all;
  const first = folders[0]?.path;
  lib.set((s) => ({ ...s, folders, foldersErr: undefined, byFolder: {}, clips: undefined, folder: undefined, open: first && !Object.keys(s.open).length ? { [first]: true } : s.open }));
  void loadFolder(uiStore.get().folder);
}
const useLib = <U,>(sel: (s: LibState) => U) => useStore(lib, sel);

let folderLoad = 0;
async function loadFolder(folder: string, force = false) {
  if (!force && lib.get().folder === folder && (lib.get().clips || lib.get().loading)) return;
  const request = ++folderLoad;
  const previousFolder = lib.get().folder;
  const accept = (clips: LibraryClip[]) => {
    const selected = clips.find(c => c.path === uiStore.get().libClip) ?? clips[0];
    lib.set(s => ({ ...s, folder, clips, loading: false, error: undefined, byFolder: { ...s.byFolder, [folder]: clips },
      frame: selected && previousFolder !== folder ? { ...s.frame, [selected.path]: 0 } : s.frame }));
  };
  const cached = !force && lib.get().byFolder[folder];
  if (cached) return accept(cached);
  lib.set((s) => ({ ...s, folder, clips: undefined, loading: true, error: undefined }));
  try {
    const clips = await engine.libraryClips(folder);
    if (request === folderLoad && lib.get().folder === folder && uiStore.get().folder === folder) accept(clips);
  } catch (error) {
    // A slow failure for a folder we already left must not clobber the current one.
    if (request === folderLoad && lib.get().folder === folder && uiStore.get().folder === folder) lib.set((s) => ({ ...s, error, loading: false, clips: undefined }));
  }
}

const framesOf = (c: LibraryClip) => rawFrames(c.probe);
function selectLibraryClip(path: string) {
  selectBrowseClip(path, {
    current: () => { const s = lib.get(); return (s.clips?.find(c => c.path === uiStore.get().libClip) ?? s.clips?.[0])?.path; },
    stop: () => { dispatchBrowseCommand('transport.stop'); },
    reset: path => lib.set(s => ({ ...s, frame: { ...s.frame, [path]: 0 } })),
    select: path => setUi({ libClip: path }),
  });
}
/** Frame target for a library clip: its project source once imported, else its path (engine resolves). */
/** Frames exist only for imported clips: the engine serves a clip's frames from its conform. */
const targetOf = (c: LibraryClip) => c.sourceId as SourceId | undefined;
const ART = ['fA', 'fB', 'fC', 'fmosh'];
const artFor = (path: string) => ART[[...path].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % ART.length];

const vfr = (c: LibraryClip) => c.probe.fps.den !== 1 && c.probe.fps.den !== 1001;

function useSelected() {
  const path = useUi((s) => s.libClip);
  const clips = useLib((s) => s.clips);
  const sources = useProject((d) => d.resources.sources);
  const conforms = useProject((d) => d.resources.conforms);
  return useMemo(() => {
    const c = clips?.find((x) => x.path === path) ?? clips?.[0];
    if (!c) return undefined;
    // A whole-file import is this clip in the project; slices (Use with IN/OUT) are separate sources,
    // so marking here keeps making new slices instead of editing one of them.
    const imported = sources.find((s) => !s.range && (s.id === c.sourceId || s.path === c.path));
    const slices = sources.filter((s) => s.path === c.path && s.range).length;
    const conform = imported && (conforms.find(cf => cf.id === imported.conformId && cf.sourceId === imported.id && !cf.range) ?? conforms.find(cf => cf.sourceId === imported.id && !cf.range));
    return { ...c, sourceId: conform ? imported?.id : undefined, imported, conform, slices };
  }, [clips, path, sources, conforms]);
}

// ---------- folder tree ----------

/**
 * Folder navigation (Waxy: stuck at the library roots). Where you are as a breadcrumb from "This PC",
 * Up a level, Browse… for any folder, and the current folder's subfolders to drill into. Any folder
 * opens: one outside the roots is indexed for its own clips the first time.
 */
function Navigator() {
  const folder = useUi((s) => s.folder) ?? '';
  const [listing, setListing] = useState<DirListing | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setListing(null);
    setErr(null);
    engine.listDir(folder).then((l) => live && (setListing(l), setErr(null)), (e) => live && (setListing(null), setErr(e)));
    return () => void (live = false);
  }, [folder]);
  // A UNC path keeps \\host\share\ together as its first crumb (bug hunt: its parts read as relative paths).
  const normalized = folder.replace(/\//g, '\\');
  const unc = normalized.startsWith('\\\\');
  const parts = (unc ? normalized.slice(2) : normalized).split('\\').filter(Boolean);
  const head = unc ? [{ name: `\\\\${parts.slice(0, 2).join('\\')}`, path: `\\\\${parts.slice(0, 2).join('\\')}\\` }] : [];
  const rest = unc ? parts.slice(2) : parts;
  const base = unc ? head[0].path.replace(/\\$/, '') : '';
  const crumbs = [{ name: 'This PC', path: '' }, ...head, ...rest.map((p, i) => ({ name: p, path: unc ? [base, ...rest.slice(0, i + 1)].join('\\') : i === 0 ? `${p}\\` : rest.slice(0, i + 1).join('\\') }))];
  crumbs[crumbs.length - 1].path = folder;
  const browse = async () => { const p = await host.files?.pickFolder('Open a folder in Source', folder || undefined); if (p) setUi({ folder: p }); };
  return (
    <div className="navig" aria-label="Folder navigation">
      <div className="navbar">
        <button className="ghostbtn browse-up" disabled={!listing || listing.parent === null} onClick={() => listing && listing.parent !== null && setUi({ folder: listing.parent })} title="Up a level" aria-label="Up a level"><Icon name="back" /></button>
        <label className="browse-location">
          <Icon name="folder" />
          <select aria-label="Current folder and parent folders" value={folder} onChange={(e) => setUi({ folder: e.target.value })}>
            {crumbs.map((c, i) => <option key={c.path || 'pc'} value={c.path}>{i === crumbs.length - 1 ? c.name : c.path || 'This PC'}</option>)}
          </select>
        </label>
        {host.files && <button className="ghostbtn" onClick={() => void browse()}>Browse…</button>}
      </div>
      {err ? <div className="navnote">{(err as { humanMessage?: string }).humanMessage ?? 'That folder could not be read.'}</div> : (
        <div className="navdirs" role="list">
          {listing?.dirs.map((d) => (
            <div key={d.path} role="listitem"><button className="tnode navdir" onClick={() => setUi({ folder: d.path })} onContextMenu={(e) => openContextMenu(e, folderMenu(d.path))} draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_FOLDER, d.path)}>
              <Icon name="folder" /><span className="browse-folder-name">{d.name}</span>
            </button></div>
          ))}
          {listing && !listing.dirs.length && <div className="navnote">No subfolders here.</div>}
        </div>
      )}
    </div>
  );
}

export function BrowserPane() {
  return <div className="browse-browser"><div className="browse-folder-navigation"><FolderTree /></div><GridPane /></div>;
}

export function FolderTree() {
  const folder = useUi((s) => s.folder);
  const folders = useLib((s) => s.folders);
  const err = useLib((s) => s.foldersErr);
  const open = useLib((s) => s.open);
  const setOpen = (fn: (o: Record<string, boolean>) => Record<string, boolean>) => lib.set((s) => ({ ...s, open: fn(s.open) }));
  useEffect(() => void loadFolders(), []);
  useEffect(() => {
    if (folder) void loadFolder(folder);
    else lib.set((s) => ({ ...s, folder: '', clips: [], loading: false })); // "This PC" (the drives): no clips, not the last folder's
    // Recents: the last 5 folders opened, by any route (EDENA's rail).
    if (folder && settingsStore.get().recentFolders[0] !== folder) setSettings((s) => void (s.recentFolders = [folder, ...s.recentFolders.filter((f) => f !== folder)].slice(0, 5)));
  }, [folder]);
  const row = (f: LibraryFolder, lvl: number): React.ReactNode => (
    <div key={f.path}>
      <div
        className={`tnode lvl${Math.min(lvl, 2)}` + (f.path === folder ? ' on' : '')}
        onClick={() => setUi({ folder: f.path })}
        onContextMenu={(e) => openContextMenu(e, folderMenu(f.path))}
        draggable
        onDragStart={(e) => e.dataTransfer.setData(DRAG_FOLDER, f.path)}
        role="treeitem"
        aria-selected={f.path === folder}
        aria-expanded={f.children.length ? !!open[f.path] : undefined}
        tabIndex={0}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setUi({ folder: f.path }); } }}
      >
        {f.children.length ? <button className="tw browse-expand" aria-label={`${open[f.path] ? 'Collapse' : 'Expand'} ${f.name}`} onClick={(e) => (e.stopPropagation(), setOpen((o) => ({ ...o, [f.path]: !o[f.path] })))}>{open[f.path] ? '▾' : '▸'}</button> : <span className="tw" />}
        <Icon name="folder" /><span className="browse-folder-name">{f.name}</span>
        <span className="cnt">{f.count}</span>
      </div>
      {open[f.path] && f.children.map((c) => row(c, lvl + 1))}
    </div>
  );
  return (
    <>
      <Navigator />
      <details className="folder-index"><summary>Library folders</summary>
      <div className="libroots dim browse-roots">
        <span>Library</span>
        <button className="ghostbtn" onClick={() => setUi({ ws: 'settings', settingsPage: 'folders' })} title="Choose library folders in Settings">Folders…</button>
        <button className="ghostbtn rescan" aria-label="Rescan library" title="Rescan the library: re-read the folders and this folder's clips from disk" onClick={() => (void loadFolders(true))}><Icon name="redo" /></button>
      </div>
      <div role="tree" aria-label="Library folders — Folder dial follows expanded rows">
        {err ? (
          <ErrorBanner error={err} />
        ) : !folders ? (
          <Loading>Reading the library index…</Loading>
        ) : !folders.length ? (
          <Empty icon="📁" title="No library folders" cta={{ label: 'Open Settings', run: () => setUi({ ws: 'settings', settingsPage: 'folders' }) }}>None of the media roots exist. Point Settings → Folders → Media root at your footage.</Empty>
        ) : (
          folders.map((f) => row(f, 0))
        )}
      </div>
      </details>
    </>
  );
}

// ---------- places: favourites + recents (EDENA's rail, Ableton Places) ----------

const nameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Keep duplicate leaf names readable without replacing a user's custom favourite label. */
export function placeContext(path: string, peers: string[], names: Record<string, string> = {}): string | undefined {
  const label = (p: string) => names[p] || nameOf(p);
  if (!peers.some((p) => p !== path && label(p).toLowerCase() === label(path).toLowerCase())) return undefined;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.slice(0, -1).join(' / ') || path;
}

export function PlacesPane() {
  const favs = useSettings((s) => s.favourites);
  const favNames = useSettings((s) => s.favouriteNames);
  const recents = useSettings((s) => s.recentFolders);
  const folder = useUi((s) => s.folder);
  const [favOpen, setFavOpen] = useSticky('places.fav', true);
  const [recOpen, setRecOpen] = useSticky('places.rec', true);
  const [over, setOver] = useState(false);
  const row = (p: string, fav: boolean) => (
    <div key={p} className={'place browse-place' + (p === folder ? ' on' : '')} onContextMenu={(e) => openContextMenu(e, folderMenu(p))}>
      <button className="browse-place-open" onClick={() => setUi({ folder: p })}>
        <Icon name="folder" /><span className="browse-place-label"><span>{(fav && favNames?.[p]) || nameOf(p)}</span>{placeContext(p, fav ? favs : recents, fav ? favNames : undefined) && <small>{placeContext(p, fav ? favs : recents, fav ? favNames : undefined)}</small>}</span>
      </button>
      {fav && <button className="px" aria-label={`Remove ${nameOf(p)} from Favourites`} title="Remove from Favourites" onClick={() => toggleFavourite(p)}>×</button>}
    </div>
  );
  // A folder dragged from the tree (or a clip, for its folder) pins it.
  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    // From Explorer: the folder itself, or a dropped file's folder; read now, while the event is live.
    if (isOsDrop(e)) {
      const paths = droppedPaths(e);
      void classify(paths).then(({ dirs, videos }) => {
        const f = dirs[0] ?? (videos[0] && osFolderOf(videos[0]));
        if (!f) return void openDropped(paths);
        if (!isFav(f)) toggleFavourite(f);
        setUi({ folder: f, ...(videos[0] && !dirs[0] ? { libClip: videos[0] } : {}) });
        toast(`★ ${nameOf(f)} added to Favourites`, { kind: 'ok' });
      });
      return;
    }
    const f = e.dataTransfer.getData(DRAG_FOLDER) || (e.dataTransfer.getData(DRAG_CLIP) && folderOf(e.dataTransfer.getData(DRAG_CLIP)));
    if (f && !isFav(f)) (toggleFavourite(f), toast(`★ ${nameOf(f)} added to Favourites`, { kind: 'ok' }));
  };
  return (
    <div className="places">
      <div className={'acc' + (over ? ' dropover' : '')} onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={drop} aria-label="Favourites">
        <button className="acchd" aria-expanded={favOpen} onClick={() => setFavOpen(!favOpen)}>
          <span className="tw">{favOpen ? '▾' : '▸'}</span>Favourites<span className="accstate">{favs.length ? `${favs.length} pinned` : 'drop a folder here'}</span>
        </button>
        {favOpen && (favs.length ? favs.map((p) => row(p, true)) : <div className="placehint">Right-click a folder ▸ Add to Favourites, or drag it here.</div>)}
      </div>
      <div className="acc" aria-label="Recents">
        <button className="acchd" aria-expanded={recOpen} onClick={() => setRecOpen(!recOpen)}>
          <span className="tw">{recOpen ? '▾' : '▸'}</span>Recent<span className="accstate">{recents.length}</span>
        </button>
        {recOpen && recents.map((p) => row(p, false))}
      </div>
    </div>
  );
}

// ---------- chapters ----------

function useChapters(c?: ReturnType<typeof useSelected>): Chapter[] {
  const session = useLib((s) => (c ? s.chapters[c.path] : undefined));
  return useMemo(() => c?.imported && c.conform ? chaptersToRaw(c.imported.chapters, c.probe, c.conform) : session ?? [],
    [c?.imported?.chapters, c?.conform, c?.probe, session]);
}

export function ChaptersPane() {
  const c = useSelected();
  const chapters = useChapters(c);
  if (!c) return null;
  const fps = c.probe.fps;
  if (!chapters.length) {
    return <Empty icon="✂" title="No chapters yet">Import the clip, then run <b>⤵ Detect cuts</b> on the preview to chunk it into shots.</Empty>;
  }
  const merge = (i: number) => {
    const original = c.imported && c.conform ? c.imported.chapters : chapters;
    const next = mergeChapterIds(original, chapters[i - 1].id, chapters[i].id);
    if (c.imported && c.conform) setChapters(c.imported.id, next, 'Merged chapters');
    else lib.set(state => ({ ...state, chapters: { ...state.chapters, [c.path]: next } }));
  };
  return (
    <div className="chaplist">
      {chapters.map((ch, i) => (
        <div key={ch.id} className="chaprow" title={`Jump to ${ch.label}`} onClick={() => lib.set((s) => ({ ...s, frame: { ...s.frame, [c.path]: ch.start } }))}>
          {targetOf(c) ? <FrameView priority="background" className="chthumb sm" target={{ kind: 'source', sourceId: targetOf(c)!, frame: chapterPreviewFrame(ch, c.imported?.chapters ?? [], c.probe, c.conform!) }} maxW={80} badges={false} /> : <div className={'chthumb frame ' + artFor(c.path)} />}
          <div className="chm"><div className="chn">{ch.label}</div><div className="chd">{timecode(ch.start, fps)}–{timecode(ch.end, fps)} · {ch.end - ch.start} f</div></div>
          {i > 0 && <button className="chmerge" onClick={(e) => (e.stopPropagation(), merge(i))} title="Merge with the chapter before">⇤ merge</button>}
        </div>
      ))}
    </div>
  );
}

export function ChapterCount() {
  const n = useChapters(useSelected()).length;
  return <span className="bscount">{n ? `${n} chapters` : 'no chapters'}</span>;
}

// ---------- big preview + slice + detect cuts ----------

export function BigPreview() {
  const [playbackRate, setPlaybackRate] = useState(0);
  const feedbackQuery = useStickyValue<string>('grid.q');
  const feedbackSort = useStickyValue<Sort>('grid.sort');
  const feedbackChips = useStickyValue<string[]>('grid.chips');
  useEffect(() => controlFeedback.changed(), [feedbackQuery, feedbackSort, feedbackChips]);
  useEffect(() => {
    const release = controlFeedback.browse(() => {
      const state = lib.get(), ui = uiStore.get();
      const clip = !state.loading && state.folder === ui.folder
        ? state.clips?.find(c => c.path === ui.libClip) ?? state.clips?.[0] : undefined;
      return browseReadout({
        folder: ui.folder, folders: visibleFolders(state.folders ?? [], state.open),
        paths: visibleClips(state.clips ?? [], readSticky<string>('grid.q'), readSticky<string[]>('grid.chips'), readSticky<Sort>('grid.sort')).map(c => c.path),
        selection: clip ? { path: clip.path, frames: framesOf(clip), frame: browseFrame(state.frame[clip.path], framesOf(clip)), marks: state.marks[clip.path] } : undefined,
      });
    });
    const unsubscribe = lib.subscribe(controlFeedback.changed);
    const unsubscribeUi = uiStore.subscribe(controlFeedback.changed);
    return () => { unsubscribe(); unsubscribeUi(); release(); };
  }, []);
  useEffect(() => {
    const selected = () => {
      const state = lib.get();
      if (state.loading || state.folder !== uiStore.get().folder) return undefined;
      return state.clips?.find(clip => clip.path === uiStore.get().libClip) ?? state.clips?.[0];
    };
    return registerBrowseControls(createBrowseCommands({
      selection: () => {
        const clip = selected(); if (!clip) return null;
        const frames = framesOf(clip), state = lib.get();
        return { path: clip.path, frames, fps: fpsValue(clip.probe.fps), frame: browseFrame(state.frame[clip.path], frames), marks: state.marks[clip.path] ?? null, usable: clip.pass === true };
      },
      folderStep: delta => {
        const state = lib.get(), paths = visibleFolders(state.folders ?? [], state.open);
        const index = paths.indexOf(uiStore.get().folder);
        if (index < 0) { toast('Choose a folder in the Library tree to use the Folder dial.', { kind: 'info' }); return; }
        const next = paths[Math.max(0, Math.min(paths.length - 1, index + delta))];
        if (next && next !== uiStore.get().folder) { setUi({ folder: next, libClip: '' }); void loadFolder(next); }
      },
      paths: () => visibleClips(lib.get().clips ?? [], readSticky<string>('grid.q'), readSticky<string[]>('grid.chips'), readSticky<Sort>('grid.sort')).map(clip => clip.path),
      select: selectLibraryClip,
      seek: (path, frame) => lib.set(state => ({ ...state, frame: { ...state.frame, [path]: frame } })),
      marks: (path, marks) => lib.set(state => ({ ...state, marks: { ...state.marks, [path]: marks } })),
      send: (which, addBlock) => { const clip = selected(); if (clip) void sendSelection(clip, which, { addBlock }).catch(toastError); },
      notice: text => toast(text, { kind: 'info' }),
    }));
  }, []);
  const c = useSelected();
  const chapters = useChapters(c);
  const frameMap = useLib((s) => s.frame);
  const marksMap = useLib((s) => s.marks);
  const bpm = useProject((d) => d.settings.bpm);
  const [sens, setSens] = useSticky('detect.sens', 5);
  const detect = useJob(c ? `detect:${c.path}` : undefined);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [scopeSample, setScopeSample] = useState<{ key: object; data: ScopeData | null } | null>(null);
  const [scopeError, setScopeError] = useState<{ key: object; message: string } | null>(null);
  const previewConform = c?.conform && !playbackRate ? c.conform : undefined;
  const scopeSource = `${c?.path ?? ''}|${previewConform?.id ?? 'raw'}`;
  const scopeFrame = c ? browseFrame(frameMap[c.path], framesOf(c)) : 0;
  // A fresh identity also clears an A → B → A switch before either new frame has arrived.
  const scopeKey = useMemo(() => ({ source: scopeSource, frame: scopeFrame }), [scopeSource, scopeFrame]);
  const scopes = scopeSample?.key === scopeKey ? scopeSample.data : null;
  const scopeFailure = scopeError?.key === scopeKey ? scopeError.message : undefined;
  const sampleScope = (cv: HTMLCanvasElement) => { setScopeSample({ key: scopeKey, data: measure(cv) }); setScopeError(null); };
  const failScope = (message: string) => { setScopeSample(null); setScopeError({ key: scopeKey, message }); };
  const [over, setOver] = useState(false);
  const loading = useLib((s) => s.loading);
  // The pane holds its raw file's decoder open while it shows it; leaving Source releases it.
  const rawPath = c?.path; // Keep raw decoding warm for smooth IN shuttle, including imported files.
  useEffect(() => (pinPreview(rawPath), () => pinPreview(undefined)), [rawPath]);
  // A raw clip's display shape after rotation (a phone clip is portrait though ffprobe says 1920×1080).
  const [rawSize, setRawSize] = useState<{ width: number; height: number } | undefined>();
  useEffect(() => {
    let live = true;
    setRawSize(undefined);
    if (rawPath) previewInfoOf(rawPath).then((i) => live && setRawSize({ width: i.width, height: i.height }), () => {});
    return () => { live = false; };
  }, [rawPath]);
  // A clip dragged from the grid opens here.
  const dropProps = {
    onDragOver: (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_CLIP) && (e.preventDefault(), setOver(true)),
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const p = e.dataTransfer.getData(DRAG_CLIP);
      if (p) selectLibraryClip(p);
    },
  };
  if (!c) return <div className="fitpane source-preview">
    <div className="source-picture"><ViewerViewport id="source" width={1920} height={1080} toolbar={<strong className="preview-source-title">Source</strong>}>
      <div className="viewer-empty">{loading ? 'Loading clips…' : 'Choose a clip in Source browser'}</div>
    </ViewerViewport></div>
    <PreviewTransport target="Source · no clip selected" frame={0} frames={0} fps={{ num: 60, den: 1 }} playing={false} onSeek={() => {}} onToggle={() => {}} seek={false} />
  </div>;
  const frames = framesOf(c);
  const frame = scopeFrame;
  // The selection on the raw file, in its own frames. Sending it to A or B is the only way a range
  // reaches the project (P0: a block must never default to the whole file).
  const marks = marksMap[c.path] ?? null;
  const isCurrent = () => {
    const state = lib.get(), ui = uiStore.get();
    return !state.loading && state.folder === ui.folder && (state.clips?.find(clip => clip.path === ui.libClip) ?? state.clips?.[0])?.path === c.path;
  };
  const setFrame = (f: number) => isCurrent() && lib.set((s) => ({ ...s, frame: { ...s.frame, [c.path]: browseFrame(f, frames) } }));
  const broken = c.pass !== true ? c.pass.code : null;
  const displaySize = previewConform ?? rawSize ?? c.probe;

  const runDetect = () => {
    const id = targetOf(c);
    if (!id) return toast('Import & conform the clip first: cuts are detected on the conform', { kind: 'warn' });
    // A background job: it finishes and stores its chapters even if you leave Source meanwhile.
    runJob(`detect:${c.path}`, 'detect', `Detect cuts · ${c.name}`, () => engine.detectCuts(id, sens), (ch: Chapter[]) => {
      // detectCuts returns conform-frame boundaries; preserve them exactly in the project.
      setChapters(id, ch, `Detected ${ch.length} chapters`);
      toast(`Detected ${ch.length} cuts → ${ch.length} chapters (rough boundaries)`, { kind: 'ok' });
    });
  };

  return (
    <div className={'fitpane source-preview' + (over ? ' dropover' : '')} {...dropProps}>
      <ScopeStrip data={scopes} sourceLabel={c.name} status={scopeFailure ? 'error' : scopes ? 'measured' : 'waiting'} detail={scopeFailure ?? (scopes ? previewConform ? `Raw f${frame} → conform f${rawPreviewFrame(frame, c.probe, previewConform)} · display RGB` : `Drawn raw preview ≈ · display RGB` : `Waiting for source f${frame}`)} />
      {broken && dismissed !== c.path && (
        <div style={{ padding: '10px 12px 0' }}>
          <ErrorBanner error={new MoshpitError(broken as never, { path: c.path })} onDismiss={() => setDismissed(c.path)} />
        </div>
      )}
      {/* Fit/Fill applies the source or conform aspect inside the fixed picture box. */}
      <div className="source-picture"><ViewerViewport id="source" width={displaySize.width} height={displaySize.height} toolbar={<strong className="preview-source-title">Source · {c.name}</strong>}>
        {previewConform ? (
          <FrameView key={scopeSource} className="bigpv" target={{ kind: 'source', sourceId: targetOf(c)!, frame: rawPreviewFrame(frame, c.probe, previewConform) }} maxW={1280} label={`f ${frame} / ${frames}`} onFrame={sampleScope} onError={failScope} />
        ) : (
          <>
            {/* The middle of frame n, not its start: n / fps lands a float step before the sample's
                timestamp on ~45% of 23.976 frames, and the decoder then shows frame n − 1. */}
            <RawFrame key={scopeSource} className="bigpv" path={c.path} timeSec={(frame + 0.5) / fpsValue(c.probe.fps)} frameSec={1 / fpsValue(c.probe.fps)} playbackRate={playbackRate} maxW={1280} onFrame={sampleScope} onError={failScope} /></>
        )}
      </ViewerViewport></div>
      <SliceTrack
        key={c.path}
        previewTarget={'Source · ' + c.name}
        isCurrent={isCurrent}
        tall
        keys
        browseControl
        onShuttleChange={setPlaybackRate}
        frames={frames}
        frame={frame}
        setFrame={setFrame}
        marks={marks}
        setMarks={(i, o) => {
          if (!isCurrent()) return;
          const m = { in: Math.max(0, i), out: Math.min(frames, o) };
          if (m.out > m.in) lib.set((s) => ({ ...s, marks: { ...s.marks, [c.path]: m } })); // IN must precede OUT
        }}
        fps={c.probe.fps}
        bpm={bpm}
        chapters={chapters}
        zoomKey={`raw:${c.path}`}
      />
      <details className="source-tools"><summary>Detect scene cuts</summary>
      <div className="detectrow" style={{ padding: '10px 11px 0' }}>
        {detect?.task ? (
          <button className="btn-run" onClick={() => cancelJob(detect.key)} title="Stop scene detection">◼ Detecting… cancel</button>
        ) : (
          <button className="btn-run" onClick={runDetect} disabled={!!broken || !targetOf(c)} title={targetOf(c) ? 'Scan for shot boundaries and chapter the file' : 'Import & conform the clip first: cuts are detected on the conform'}>⤵ Detect cuts</button>
        )}
        <div className="sensparam">
          <ParamControl variant="mini" fieldKey="scene|sens" spec={{ label: 'Sensitivity', type: 'int', min: 1, max: 10, step: 1, default: 5, help: 'Higher finds more cuts' }} value={sens} onChange={(v) => setSens(v as number)} />
        </div>
        <ChapterCount />
        <span className="dim" style={{ fontSize: 10 }}><span className="approx">≈</span> rough boundaries · shown in source frames</span>
      </div>
      </details>
    </div>
  );
}

// ---------- import / conform ----------

/** The slice bar's Use action for a raw clip: the one POP in this context. */
/**
 * Browse → Mark → Send (external review §2, P0): nothing is committed by browsing or marking. Send
 * to A / Send to B brings exactly the marked range into the project and loads it there; with no
 * valid selection they are disabled. "Select entire clip" is the only way to take the whole file.
 */
function SendButtons({ c, compact }: { c: LibraryClip; compact?: boolean }) {
  const job = useJob(`import:${c.path}`);
  useLib((s) => s.marks[c.path]); // re-label when IN/OUT move
  if (job?.task) return <span className="tbtn usebusy" title="Bringing the selection in, in the background — it keeps going whatever you open">⟳ {Math.round(job.fraction * 100)}%</span>;
  const r = rangeOf(c);
  const bad = c.pass !== true;
  const why = bad ? 'This clip cannot be conformed' : r ? undefined : 'Mark IN and OUT first (I / O), or Select entire clip';
  return (
    <span className="sendbtns">
      <button className="tbtn select-entire" disabled={bad} onClick={() => selectEntire(c)} title="Mark the whole clip as the selection (IN at the first frame, OUT after the last)">Select entire clip</button>
      {(['A', 'B'] as const).map((w) => (
        <button key={w} className="tbtn" disabled={!r || bad} onClick={() => void sendSelection(c, w)} title={why ?? `Bring ${rangeText(r!, c.probe.fps)} into the project and load it in slot ${w}`}>
          Load source {w}{r && !compact ? ` · ${r.durSec.toFixed(2)} s` : ''}
        </button>
      ))}
      <button className="tbtn pop add-range" disabled={!r || bad} onClick={() => void sendSelection(c, 'A', { addBlock: true })} title={why ?? `Bring ${rangeText(r!, c.probe.fps)} in and add it to the arrangement as a block, straight from here`}>＋ Add range to edit</button>
    </span>
  );
}

/** A range as IN–OUT timecode at the clip's rate, the readout's notation (OUT exclusive, so a 1-frame slice reads 0:01.14–0:01.15). */
const spanText = (r: SourceRange, fps: { num: number; den: number }) => {
  const f = (s: number) => Math.round((s * fps.num) / fps.den);
  return { text: `${timecode(f(r.startSec), fps)}–${timecode(f(r.startSec + r.durSec), fps)}`, frames: f(r.startSec + r.durSec) - f(r.startSec) };
};
const rangeText = (r: SourceRange, fps: { num: number; den: number }) => { const s = spanText(r, fps); return `${s.text} (${s.frames} f)`; };
function selectEntire(c: LibraryClip) {
  lib.set((s) => ({ ...s, marks: { ...s.marks, [c.path]: { in: 0, out: framesOf(c) } } }));
}

function addBlockFrom(id: SourceId, inF: number, outF: number, name: string) {
  try {
    addBlock(id, inF, outF);
    toast(`Added ${outF - inF} f of ${name} to the arrangement`, { kind: 'ok', action: { label: 'Open in MOSH', run: () => setWs('mosh') } });
  } catch (e) {
    toastError(e);
  }
}

/** The persistent readout: whole source vs the selection, in exact frames (timecode is display). */
function SelectionReadout({ c }: { c: LibraryClip }) {
  const m = useLib((s) => s.marks[c.path]);
  const n = framesOf(c);
  return (
    <div className="selread" aria-live="polite">
      <span><MediaMark kind="source" /><b><Timecode frame={n} fps={c.probe.fps} /></b><em><MediaMark kind="frames" /> {n} <MediaMark kind="rate" /> {fmtFps(c.probe.fps)}</em></span>
      {m && m.out > m.in ? (
        <span className="on"><MediaMark kind="range" label="Selected" /><b className="browse-selected-times"><MediaMark kind="in" /><Timecode frame={m.in} fps={c.probe.fps} /><MediaMark kind="out" /><Timecode frame={m.out} fps={c.probe.fps} /></b><em title={`Frames ${m.in} through ${m.out - 1}; OUT is exclusive`}><MediaMark kind="frames" /> {m.out - m.in} <MediaMark kind="duration" /> {((m.out - m.in) / fpsValue(c.probe.fps)).toFixed(2)} s{m.in === 0 && m.out >= n ? ' · entire clip' : ''}</em></span>
      ) : (
        <span className="none"><MediaMark kind="range" label="Selected" /><b>Nothing marked</b><em>mark I / O, or Select entire clip</em></span>
      )}
    </div>
  );
}

/** The slice Use brings in: the IN/OUT marked on the raw file, in the file's own seconds. None = whole file. */
export function rangeOf(c: LibraryClip): SourceRange | undefined {
  const m = lib.get().marks[c.path];
  if (!m || m.out <= m.in) return undefined;
  const f = fpsValue(c.probe.fps);
  return { startSec: m.in / f, durSec: (m.out - m.in) / f };
}
/** The selection is the entire file: imported as the whole clip (one conform, no range). */
const isEntire = (c: LibraryClip) => {
  const m = lib.get().marks[c.path];
  return !!m && m.in === 0 && m.out >= framesOf(c);
};
const mmss = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/**
 * Use a clip: import + conform it into the project, as a background job (audit B1). The only
 * place conform happens — looking at a file never triggers it. Marks and chapters set on the raw
 * file come along.
 */
export async function sendSelection(c: LibraryClip, which: 'A' | 'B', also: { addBlock?: boolean } = {}) {
  const sel = rangeOf(c);
  if (!sel) return toast('Mark IN and OUT first (I / O), or Select entire clip — nothing is sent without a selection', { kind: 'warn' });
  const range = isEntire(c) ? undefined : sel;
  const opts = { toLoupe: which, addBlock: also.addBlock };
  // The same file and slice already in the project is not imported again (Waxy ended up with two
  // full copies of one film: the old guard was a session-only flag on the library entry).
  const dup = getDoc().resources.sources.find((s) => s.path === c.path && sameSourceRange(s.range, range, c.probe.fps));
  if (dup) {
    setLoupe(which, { src: dup.id, frame: 0 }), setUi({ sliceTarget: which });
    if (also.addBlock && dup.marks[0]) return void addBlockFrom(dup.id, dup.marks[0].in, dup.marks[0].out, dup.name);
    toast(`${dup.name} is already in the project — loaded in loupe ${which}`, { kind: 'info', action: { label: 'Open in MOSH', run: () => setWs('mosh') } });
    return;
  }
  // A long selection is minutes of encoding and gigabytes of cache: say so before starting.
  if (sel.durSec > 300) {
    const go = await choose(
      `Conform ${mmss(sel.durSec)} of ${c.name}?`,
      h('p', null, `The selection is ${mmss(sel.durSec)} long${range ? '' : ' (the entire clip)'}. Conforming it takes minutes and gigabytes of cache. Mark a shorter IN/OUT to bring in only the part you will use.`),
      [
        { label: 'Mark a shorter range', value: false, kind: 'primary' },
        { label: 'Conform it all', value: true, kind: 'ghost' },
      ],
      0,
      '✂',
    );
    if (!go) return;
  }
  // Every source joins the existing composition rate; its duration is preserved.
  startImport(c, range, opts);
}

/** Use several clips at once at the composition rate, each as a background job. */
export async function addClips(list: LibraryClip[]) {
  // Explicitly the ENTIRE clips (the button says so): no per-clip selection is implied.
  const inProject = new Set(getDoc().resources.sources.filter((s) => !s.range).map((s) => s.path));
  const todo = list.filter((c) => !inProject.has(c.path) && c.pass === true);
  if (!todo.length) return toast('Nothing to add: those clips are in the project already, or cannot be conformed', { kind: 'info' });
  // Mixed frame rates share the project clock without changing its settings.
  todo.forEach((c) => startImport(c, undefined));
  toast(`Adding ${todo.length} clip${todo.length > 1 ? 's' : ''} in the background — each is usable as soon as its proxy is ready`, { kind: 'ok' });
}

function startImport(c: LibraryClip, range: SourceRange | undefined, opts: { toLoupe?: 'A' | 'B'; addBlock?: boolean } = {}) {
  dismissJob(`import:${c.path}`);
  const settings = getDoc().settings;
  const format = { fps: { ...settings.fps }, working: { ...settings.working } };
  const quality = settingsStore.get().conformQuality;
  const label = range ? `${c.name} [${spanText(range, c.probe.fps).text}]` : c.name;
  runJob(`import:${c.path}`, 'import', `Import · ${label}`, (onProgress) => engine.importClip(c.path, onProgress as (p: ImportProgress) => void, { quality, range }), ({ source, conform }: { source: SourceClip; conform: ConformedSource }) => {
    if (!canAdoptImport(format, conform)) return;
    const { chapters } = lib.get();
    if (range && !source.range) {
      // Never let a requested slice land as the whole file (P0-A): refuse it loudly instead.
      toastError(new MoshpitError('SLICE_RANGE_INVALID', { path: c.path, range, why: 'the conform came back without its range' }));
      return;
    }
    if (source.range) {
      // A slice: only IN→OUT was conformed, so the source is the slice and IN/OUT span all of it.
      addSource({ ...source, name: label, marks: [{ id: `mark-${source.id}` as never, in: 0, out: Math.max(1, conform.frames) }] }, conform);
    } else {
      addSource({ ...source, chapters: chapters[c.path] ? chaptersToConform(chapters[c.path], c.probe, conform) : source.chapters, marks: [{ id: `mark-${source.id}` as never, in: 0, out: Math.max(1, conform.frames) }] }, conform);
      patchClip(c.path, { sourceId: source.id });
    }
    const m = { in: 0 };
    if (opts.addBlock) addBlockFrom(source.id, 0, Math.max(1, conform.frames), label);
    // Proxy-first: usable on the proxy now; the full-quality master follows in the background.
    const now = conform.status === 'proxy' ? `${label} is in the project and usable now — full quality finishes in the background` : `${label} conformed and added to the project`;
    // Sent to A or B: it lands in that loupe (and becomes its slice target).
    if (opts.toLoupe) (setLoupe(opts.toLoupe, { src: source.id, frame: m.in }), setUi({ sliceTarget: opts.toLoupe }));
    toast(now + (opts.toLoupe ? ` — in loupe ${opts.toLoupe}` : ''), { kind: 'ok', action: { label: 'Open in MOSH', run: () => setWs('mosh') } });
  });
}

export function ConvertPane() {
  const c = useSelected();
  useLib((s) => (c ? s.marks[c.path] : undefined)); // re-label Use when IN/OUT move
  const fps = useProject((d) => d.settings.fps);
  const working = useProject((d) => d.settings.working);
  const quality = useSettings((s) => s.conformQuality);
  // The import is an app-level job keyed by the file: it outlives this pane (audit B1).
  const job = useJob(c ? `import:${c.path}` : undefined);
  const prog = job?.task ? (job as { stage?: ImportProgress['stage']; fraction: number }) : null;
  const err = job && !job.task ? job.error : null;
  if (!c) return null;
  // A clip dragged here is selected for marking; dropping never imports anything.
  const drop = (e: React.DragEvent) => {
    const p = e.dataTransfer.getData(DRAG_CLIP);
    if (!lib.get().clips?.some((x) => x.path === p)) return;
    e.preventDefault();
    selectLibraryClip(p);
  };
  return (
    <div className="convbar" onDragOver={(e) => e.dataTransfer.types.includes(DRAG_CLIP) && e.preventDefault()} onDrop={drop}>
      {err != null && <div style={{ width: '100%' }}><ErrorBanner error={err} onDismiss={() => dismissJob(`import:${c.path}`)} /></div>}
      <strong className="selection-summary">{c.name}</strong>
      {job?.task ? (
        <>
          <div className="importprog">
            <span>{prog?.stage === 'proxy' ? 'proxy — usable in a moment' : prog?.stage ?? 'starting'}…</span>
            {/* Proxy-first: probe, then the proxy (the import resolves there); 'conform' only on a one-shot import. */}
            <div className="bar"><div className="fill" style={{ width: `${(prog ? (prog.stage === 'probe' ? 0.1 * prog.fraction : 0.1 + 0.9 * prog.fraction) * 100 : 0).toFixed(0)}%` }} /></div>
          </div>
          <button className="ghostbtn" onClick={() => cancelJob(`import:${c.path}`)}>Cancel</button>
        </>
      ) : (
        <>
          <SelectionReadout c={c} />
          <SendButtons c={c} />
        </>
      )}
      <details className="prepare-media"><summary>Prepare media</summary><div className="prepare-media-body">
      <div className="fld pathfld"><label>Source</label><input className="sel2" value={c.path} readOnly /></div>
      <div className="fld"><label>Conform to</label><span className="sel2 ro" title="L29: Main profile, no B-frames, closed GOP, one reference — the moshable form">H.264 Main · moshable</span></div>
      <div className="fld"><label>Working size</label><span className="sel2 ro">{working.w}×{working.h}</span></div>
      <div className="fld qfld">
        <label>Quality</label>
        <RadialPick
          title="Conform quality"
          value={quality}
          options={CONFORM_QUALITIES.map((q) => ({ label: q.label, value: q.id, hint: `${q.hint} (x264 ${q.x264})`, color: q.id === 'balanced' ? 'var(--fn-interactive)' : 'var(--fn-select)' }))}
          onChange={(v) => setSettings((s) => void (s.conformQuality = v))}
          label={CONFORM_QUALITIES.find((q) => q.id === quality)?.label ?? quality}
          hint="Speed ↔ smoothness: slower finds cleaner motion vectors, which is what a mosh smears. Every preset moshes and mixes on one timeline."
        />
        <span className="qhint">{CONFORM_QUALITIES.find((q) => q.id === quality)?.hint}</span>
      </div>
      <div className="fld"><label>FPS</label><span className="sel2 ro" title="Variable frame rate is conformed to the project's rational fps, never refused">{vfr(c) ? '≈vfr → ' : ''}{fmtFps(fps)}</span></div>
      </div></details>
      <span className="rosafe" title="Moshpit only reads this file. Slicing, moshing and rendering use a conformed copy in the cache; the original is never changed, moved or deleted.">READ-ONLY SOURCE</span>
      {c.imported && !job?.task && <span className="hdnote mint">✓ entire clip in project <ConformBadge sourceId={c.imported.id} /></span>}
      {c.slices > 0 && <span className="hdnote" title="Each Send adds its range as its own clip">{c.slices} slice{c.slices > 1 ? 's' : ''} of this file in the project</span>}
    </div>
  );
}

// ---------- right-click menus ----------

const folderOf = (p: string) => p.slice(0, p.lastIndexOf('\\'));
const isFav = (folder: string) => settingsStore.get().favourites.includes(folder);
export function toggleFavourite(folder: string) {
  setSettings((s) => void (s.favourites = s.favourites.includes(folder) ? s.favourites.filter((f) => f !== folder) : [...s.favourites, folder]));
}

function clipMenu(c: LibraryClip): (MenuItem | '-')[] {
  const many = (lib.get().clips ?? []).filter((x) => lib.get().picked.includes(x.path));
  return [
    ...(many.length > 1 ? [{ label: `⤓ Add ${many.length} entire clips`, run: () => void addClips(many) }, '-' as const] : []),
    { label: 'Preview', run: () => selectLibraryClip(c.path) },
    { label: 'Select entire clip', run: () => (selectLibraryClip(c.path), selectEntire(c)), disabled: c.pass !== true },
    { label: 'Send selection to A', run: () => void sendSelection(c, 'A'), disabled: c.pass !== true || !rangeOf(c), hint: rangeOf(c) ? rangeText(rangeOf(c)!, c.probe.fps) : 'mark I / O first' },
    { label: 'Send selection to B', run: () => void sendSelection(c, 'B'), disabled: c.pass !== true || !rangeOf(c), hint: rangeOf(c) ? rangeText(rangeOf(c)!, c.probe.fps) : 'mark I / O first' },
    '-',
    { label: isFav(folderOf(c.path)) ? '★ Remove folder from Favourites' : '☆ Add folder to Favourites', run: () => toggleFavourite(folderOf(c.path)) },
    { label: 'Reveal in Explorer', run: () => void host.files?.reveal(c.path), disabled: !host.files },
    { label: 'Copy path', run: () => void navigator.clipboard.writeText(c.path).then(() => toast('Path copied', { kind: 'ok' })) },
  ];
}

function folderMenu(path: string): (MenuItem | '-')[] {
  return [
    { label: 'Open', run: () => setUi({ folder: path }) },
    { label: isFav(path) ? '★ Remove from Favourites' : '☆ Add to Favourites', run: () => toggleFavourite(path) },
    '-',
    { label: 'Rescan library', run: () => void loadFolders(true) },
    { label: 'Reveal in Explorer', run: () => void host.files?.reveal(path), disabled: !host.files },
    { label: 'Copy path', run: () => void navigator.clipboard.writeText(path).then(() => toast('Path copied', { kind: 'ok' })) },
  ];
}

// ---------- grid ----------


export function GridPane() {
  const { clips, loading, error, folder } = useLib((s) => s);
  const sel = useSelected();
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => { grid.current?.querySelector<HTMLElement>('.gcell.sel, .rtable tr.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [sel?.path]);
  // B7: the search, sort, chips and view survive a workspace switch.
  const [q, setQ] = useSticky('grid.q', '');
  const [sort, setSort] = useSticky<Sort>('grid.sort', 'name');
  const [chips, setChips] = useSticky<string[]>('grid.chips', []);
  const [view, setView] = useSticky<'thumbs' | 'list'>('grid.view', 'thumbs');
  const shown = useMemo(() => visibleClips(clips ?? [], q, chips, sort), [clips, q, chips, sort]);
  const clear = () => (setQ(''), setChips([]));
  const picked = useLib((s) => s.picked);
  const cell = useSettings((s) => s.gridCell);
  // Click = this clip; Ctrl/Cmd-click = add/remove; Shift-click = the range from the last click.
  const pick = (e: React.MouseEvent, c: LibraryClip) => {
    const st = lib.get();
    if (e.shiftKey && st.anchor) {
      const a = shown.findIndex((x) => x.path === st.anchor), b = shown.findIndex((x) => x.path === c.path);
      const range = shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path);
      lib.set((s) => ({ ...s, picked: [...new Set([...s.picked, ...range])] }));
    } else if (e.ctrlKey || e.metaKey) {
      lib.set((s) => ({ ...s, anchor: c.path, picked: s.picked.includes(c.path) ? s.picked.filter((p) => p !== c.path) : [...s.picked, c.path] }));
    } else {
      lib.set((s) => ({ ...s, anchor: c.path, picked: [c.path] }));
    }
    selectLibraryClip(c.path);
  };
  const pickedClips = shown.filter((c) => picked.includes(c.path));
  const addable = pickedClips.filter((c) => !c.sourceId && c.pass === true);

  return (
    <div className="browse-clips" ref={grid}>
      <div className="browse-intro">
        <span className="browse-folder-summary"><Icon name="source" /><b>{folder ? nameOf(folder) : 'Your footage'}</b></span>
        <StarterMoshButton />
      </div>
      <div className="bstoolbar browse-toolbar">
        <div className="bsearch"><input placeholder="Find clips…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter clips" /></div>
        <RadialPick
          title="Sort"
          className="sortsel radfield"
          value={sort}
          options={[
            { label: 'Name', value: 'name', color: 'var(--teal)' },
            { label: 'Duration', value: 'duration', color: 'var(--lav)' },
            { label: 'Rating', value: 'rating', color: 'var(--fn-interactive)' },
            { label: 'Size', value: 'size', color: 'var(--coral)' },
          ]}
          onChange={(v) => setSort(v as Sort)}
          label={{ name: 'Name', duration: 'Duration', rating: 'Rating', size: 'Size' }[sort]}
        />
        <div className="seg" role="group" aria-label="View">
          {(['thumbs', 'list'] as const).map((v) => <button key={v} aria-pressed={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'thumbs' ? 'Thumbnails' : 'List'}</button>)}
        </div>
      </div>
      <div className="picktools">
        <button className="ghostbtn" onClick={() => lib.set((s) => ({ ...s, picked: shown.map((c) => c.path) }))} title="Select every clip the filter shows">All</button>
        <button className="ghostbtn" disabled={!picked.length} title={picked.length ? 'Clear the picked clips' : 'Nothing picked: Ctrl-click clips to pick several'} onClick={() => lib.set((s) => ({ ...s, picked: [] }))}>None</button>
        <span className="pickcount" title="Ctrl-click to select several clips; Shift-click for a range">{pickedClips.length ? `${pickedClips.length} selected` : `${shown.length} clips`}{shown.length !== clips?.length ? ` / ${clips?.length ?? 0}` : ''}</span>
        {addable.length > 1 && (
          <button className="pop" onClick={() => void addClips(addable)} title="Bring the ENTIRE clips in, one background import each, usable as each proxy lands. To take part of a clip, mark it and Send it instead.">
            ⤓ Add {addable.length} entire clips
          </button>
        )}
        <label className="cellsize" title="Thumbnail size">
          <Icon name="source" size={12} />
          <input type="range" min={96} max={320} step={8} value={cell} onChange={(e) => setSettings((s) => void (s.gridCell = Number(e.target.value)))} aria-label="Thumbnail size" />
          <Icon name="source" size={18} />
        </label>
      </div>
      <div className="chips" style={{ borderBottom: 'none', paddingTop: 0 }}>
        {CHIPS.map((c) => (
          <button key={c.k} role="checkbox" aria-checked={chips.includes(c.k)} className={'chip' + (chips.includes(c.k) ? ' on' : '')} onClick={() => setChips((x) => (x.includes(c.k) ? x.filter((y) => y !== c.k) : [...x, c.k]))}>{c.label}</button>
        ))}
      </div>
      <div className="browse-clip-results">
      {error ? (
        <div style={{ padding: 11 }}><ErrorBanner error={error} action={{ label: 'Retry', run: () => (lib.set((s) => ({ ...s, folder: undefined })), loadFolder(folder!)) }} /></div>
      ) : loading && !clips ? (
        <Loading>Indexing folder…</Loading>
      ) : !shown.length ? (
        q || chips.length ? (
          <Empty icon="⌕" title="Nothing matches the filter" cta={{ label: 'Clear filter', run: clear }}>{clips?.length ?? 0} clip{clips?.length === 1 ? '' : 's'} in this folder, hidden by the search or chips.</Empty>
        ) : folder ? (
          <Empty icon="📁" title="No video files in this folder">Open a subfolder in FOLDERS, go up a level, use Browse…, or drop a folder or video files here from Explorer.</Empty>
        ) : (
          <Empty icon="📁" title="Pick a folder">Choose a folder on the left to see its clips. Nothing is imported until you send a range.</Empty>
        )
      ) : view === 'thumbs' ? (
        <div className="grid-thumbs" style={{ '--cell': `${cell}px` } as React.CSSProperties}>
          {shown.map((c) => (
            <div
              key={c.path}
              className={'gcell' + (c.path === sel?.path ? ' sel' : '') + (picked.includes(c.path) && picked.length > 1 ? ' picked' : '')}
              onClick={(e) => pick(e, c)}
              onContextMenu={(e) => openContextMenu(e, clipMenu(c))}
              draggable
              onDragStart={(e) => (e.dataTransfer.setData(DRAG_CLIP, c.path), (e.dataTransfer.effectAllowed = 'copy'))}
            >
              <div className="gt2">
                <CellThumb path={c.path} durationSec={c.probe.durationSec} />
                {c.pass !== true ? <span className="st2" style={{ color: 'var(--fn-destructive)' }}>Unsupported</span> : vfr(c) ? <span className="st2" title="Variable frame rate">≈ VFR</span> : null}
                <span className="dur"><Timecode frame={framesOf(c)} fps={c.probe.fps} /></span>
                {c.sourceId && <span className="inproj" title="Imported into this project">◧</span>}
              </div>
              <div className="gm">
                <div className="nm">{c.name}</div>
                <div className="mt">{c.probe.codec} · {c.probe.width}×{c.probe.height} · {fmtFps(c.probe.fps)} <span className="stars">{'★'.repeat(c.rating)}</span></div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table className="rtable">
          <thead><tr><th>Name</th><th>Codec</th><th>Size</th><th>FPS</th><th>Length</th><th>★</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.path} className={(c.path === sel?.path ? 'cur' : '') + (picked.includes(c.path) && picked.length > 1 ? ' picked' : '')} onClick={(e) => pick(e, c)} onContextMenu={(e) => openContextMenu(e, clipMenu(c))} draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_CLIP, c.path)}>
                <td>{c.name}</td><td>{c.probe.codec}</td><td>{c.probe.width}×{c.probe.height}</td><td>{fmtFps(c.probe.fps)}</td><td>{timecode(framesOf(c), c.probe.fps)}</td><td className="stars">{'★'.repeat(c.rating)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </div>
    </div>
  );
}

// ---------- metadata ----------

export function MetaPane() {
  const c = useSelected();
  const chapters = useChapters(c);
  if (!c) return <Empty icon="▤" title="No clip selected" />;
  const p = c.probe;
  const rows: [string, React.ReactNode][] = [
    ['Codec', p.codec],
    ['Resolution', `${p.width}×${p.height}`],
    ['Frame rate', <>{fmtFps(p.fps)} <span className="dim">({p.fps.num}/{p.fps.den})</span></>],
    ['Duration', `${timecode(framesOf(c), p.fps)} · ${framesOf(c)} f`],
    ['Pixel format', p.pixFmt],
    ['Alpha', p.hasAlpha ? <span style={{ color: 'var(--gold)' }}>yes — dropped by the moshable conform</span> : 'no'],
    ['Audio', p.audio ? `${p.audio.codec} · ${p.audio.sampleRate / 1000} kHz · ${p.audio.layout}` : '—'],
    ['Chapters', chapters.length ? `${chapters.length} detected` : '—'],
    ['Rating', <Stars c={c} />],
    ['Tags', <TagsField c={c} />],
    ['Status', c.pass === true ? <span style={{ color: 'var(--fn-valid)' }}>pass ✓</span> : <span style={{ color: 'var(--fn-destructive)' }}>fail — {c.pass.code}</span>],
    ['Project', c.imported ? <span style={{ color: 'var(--mint)' }}>imported ✓</span> : 'not imported'],
  ];
  return (
    <div className="inspector-body">
      <div className="ih"><span className="ic" style={{ background: 'var(--panel-3)' }}>▤</span><div><b>{c.name}</b><div className="grp">ffprobe · measured</div></div></div>
      <table className="metatable"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
      <div style={{ padding: '10px 12px' }}>
        <button
          className="ghostbtn"
          style={{ width: '100%', justifyContent: 'center' }}
          title="Move this file to the Recycle Bin (asks first; never a hard delete)"
          onClick={async () => {
            if (await confirmAction('Move clip to the Recycle Bin?', <>Move <b>{c.name}</b> to the Recycle Bin? Sources are never overwritten; recover it from the Bin.</>, 'Move to Bin')) {
              toast('Library file operations are not wired to the engine yet — nothing was moved', { kind: 'warn' });
            }
          }}
        >
          🗑 Move to Recycle Bin…
        </button>
      </div>
    </div>
  );
}

// ---------- library metadata (engine index) ----------

function Stars({ c }: { c: LibraryClip }) {
  const set = (n: number) => {
    const old = c.rating;
    patchClip(c.path, { rating: n });
    engine.setRating(c.path, n).catch((e) => (patchClip(c.path, { rating: old }), toastError(e)));
  };
  return (
    <span className="stars edit" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} role="radio" aria-checked={c.rating === n} title={`${n} star${n > 1 ? 's' : ''} (click again to clear)`} onClick={() => set(c.rating === n ? 0 : n)}>
          {n <= c.rating ? '★' : '☆'}
        </button>
      ))}
    </span>
  );
}

function TagsField({ c }: { c: LibraryClip }) {
  const [v, setV] = useState(c.tags.join(', '));
  useEffect(() => setV(c.tags.join(', ')), [c.path, c.tags]);
  const commit = () => {
    const tags = v.split(',').map((t) => t.trim()).filter(Boolean);
    if (tags.join(',') === c.tags.join(',')) return;
    const old = c.tags;
    patchClip(c.path, { tags });
    engine.setTags(c.path, tags).catch((e) => (patchClip(c.path, { tags: old }), toastError(e)));
  };
  return <input className="tagsedit" value={v} placeholder="add tags, comma-separated" onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} aria-label="Tags" />;
}

// ---------- live state for collapsed pane headers (Arena-style accordions) ----------

export function MetaState() {
  const c = useSelected();
  if (!c) return null;
  return <span className="accstate">{c.probe.codec} · {c.probe.width}×{c.probe.height} · {fmtFps(c.probe.fps)}</span>;
}

export function UseState() {
  const c = useSelected();
  const job = useJob(c ? `import:${c.path}` : undefined);
  if (!c) return null;
  if (job?.task) return <span className="accstate warn">importing {Math.round(job.fraction * 100)}%</span>;
  return c.imported ? <span className="accstate ok">in project <ConformBadge sourceId={c.imported.id} /></span> : <span className="accstate">raw · not in project</span>;
}

// ---------- Compose's Library: use footage without leaving the work (research §6e) ----------

/** A slim projection of the IN browser for Compose's left rail: the same cached library,
 *  hover-scrub thumbnails, and Use straight into loupe A. */
export function LibraryStrip() {
  const folder = useUi((s) => s.folder);
  const clips = useLib((s) => s.clips);
  const loading = useLib((s) => s.loading);
  const error = useLib((s) => s.error);
  const favs = useSettings((s) => s.favourites);
  const recents = useSettings((s) => s.recentFolders);
  const [q, setQ] = useSticky('library.q', '');
  useEffect(() => void loadFolders(), []);
  useEffect(() => void loadFolder(folder), [folder]);
  const places = [...new Set([folder, ...favs, ...recents].filter(Boolean))];
  const shown = (clips ?? []).filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="libstrip">
      <div className="libhd">
        <RadialPick
          title="Library folder"
          className="sel2 radfield"
          value={folder}
          options={places.map((p, i) => ({ label: nameOf(p), value: p, color: favs.includes(p) ? 'var(--fn-warn)' : 'var(--fn-info)', hint: `${favs.includes(p) ? '★ favourite' : i === 0 ? 'current folder' : 'recent'} · ${p}` }))}
          onChange={(v) => setUi({ folder: v })}
          label={nameOf(folder)}
        />
        <input className="libq" placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the library" />
      </div>
      {/* Phase 0.6: a folder that failed to read is an error, not "no clips". */}
      {error ? (
        <div style={{ padding: 8 }}><ErrorBanner error={error} action={{ label: 'Retry', run: () => void loadFolder(folder, true) }} /></div>
      ) : loading && !clips ? (
        <Loading>Reading the folder…</Loading>
      ) : !shown.length ? (
        q.trim() ? (
          <Empty icon="⌕" title={`No clip names match “${q.trim()}”`} cta={{ label: 'Clear search', run: () => setQ('') }}>{clips?.length ?? 0} clip{clips?.length === 1 ? '' : 's'} in this folder.</Empty>
        ) : (
          <Empty icon="▤" title={folder ? 'No video files in this folder' : 'Pick a folder'}>Pick another folder above, or browse in IN (Alt+1).</Empty>
        )
      ) : (
        <div className="librows">
          {shown.map((c) => <LibRow key={c.path} c={c} />)}
        </div>
      )}
    </div>
  );
}

function LibRow({ c }: { c: LibraryClip }) {
  const job = useJob(`import:${c.path}`);
  return (
    <div className="librow" onContextMenu={(e) => openContextMenu(e, clipMenu(c))}>
      <div className="libthumb"><CellThumb path={c.path} durationSec={c.probe.durationSec} /></div>
      <div className="libmeta">
        <div className="nm">{c.name}</div>
        <div className="mt">{c.probe.codec} · {c.probe.width}×{c.probe.height} · {timecode(framesOf(c), c.probe.fps).replace(/\.\d+$/, '')}</div>
      </div>
      {job?.task ? (
        <span className="libbusy">⟳ {Math.round(job.fraction * 100)}%</span>
      ) : c.sourceId ? (
        <>
          <button className="ghostbtn" onClick={() => (setLoupe('A', { src: c.sourceId!, frame: 0 }), setUi({ sliceTarget: 'A' }))} title="In the project: show it in loupe A and slice it there">→ A</button>
          <button className="ghostbtn" onClick={() => (setLoupe('B', { src: c.sourceId!, frame: 0 }), setUi({ sliceTarget: 'B' }))} title="In the project: show it in loupe B and slice it there">→ B</button>
        </>
      ) : (
        <button className="ghostbtn act" disabled={c.pass !== true} onClick={() => (selectLibraryClip(c.path), setWs('browse'))} title="Open it in IN to mark the range you want, then Send it to A or B">Mark in IN →</button>
      )}
    </div>
  );
}
