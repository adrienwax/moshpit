// Session UI state (not undoable, not in the project) + user/app settings persisted to disk (L13).
import type { Recipe } from './recipes';
import { createStore, useStore } from './store';
import { host } from '../host';
import { toast } from '../qol/qol';
import { sanitizeEffectPresets } from '../lib/effectPresets';
import { TEST_CLIPS_DIR, TEST_CLIPS_NAME } from '../lib/testClips';
import { DEFAULT_CONFORM_QUALITY, type Block, type BlockGraph, type ComponentDef, type ConformQuality, type ParamValue } from '@moshpit/engine';

// Three workspaces in sequence — SOURCE (browse) · COMPOSE (mosh) · RENDER — with Settings
// outside it (usability plan S1). 'node' is not a workspace: it is Open Graph on the selected
// block, a full-screen mode of COMPOSE (S2). The ids stay as they were: they are internal, saved
// layouts key on them, and CT commands (workspace.node, …) address them.
export type WsId = 'home' | 'browse' | 'mosh' | 'node' | 'render' | 'settings';
export const WS_KEYS: Record<string, WsId> = { '0': 'home', '1': 'browse', '2': 'mosh', '3': 'render' };
// Workspaces read IN · MOSH · OUT (Waxy); the ids stay browse · mosh · render.
export const WS_LABEL: Record<WsId, string> = { home: 'Home', browse: 'In', mosh: 'Mosh', node: 'Graph', render: 'Out', settings: 'Settings' };

export interface UiState {
  ws: WsId;
  settingsReturn?: Exclude<WsId, 'settings'>;
  /** Timeline playhead, in timeline frames. Repainted on rAF; never drives engine state (L9). */
  playhead: number;
  playing: boolean;
  /** Focus of the timeline's parameter lane; does not change the saved animation. */
  animation?: { blockId: string; nodeId: string; key: string };
  /** Per-field ♪⇄s toggles, keyed `${nodeId}|${paramKey}`. */
  seconds: Record<string, boolean>;
  /** Browse: selected library folder + clip path. */
  folder: string;
  libClip?: string;
  /** The "＋ Add effect" side panel is open. */
  fxPanel: boolean;
  /** Mosh mode's two loupes: which clip each shows and at which frame (on its conform). */
  loupes: Record<'A' | 'B', { src?: string; frame: number }>;
  snap: 'frame' | 'beat' | 'bar';
  /** Phase E: the loupe the slice timeline, I / O and CT mark commands work on. */
  sliceTarget: 'A' | 'B';
  /** The History drawer (it left the inspector's tabs). */
  historyOpen: boolean;
  /** Settings nav selection. */
  settingsPage: string;
  /** Render: job whose log is shown. */
  renderJob?: string;
  /** The output frame at the playhead: EXACT or PROXY (≈). Set by the top-bar scopes; shown on the status strip. */
  outState?: 'EXACT' | 'PROXY';
  /** Phase 2.2: an effect or recipe auditioned on a block. The Program shows it; the project does not have it. */
  audition?: Audition;
  /** Phase 2.2: Shift-clicked candidates to compare, at most four. */
  shortlist: Audition[];
  /** Phase 2.6: during an audition, the original is shown (held: the \ key, or the Original button). */
  reveal?: boolean;
  /** Phase 2.6: during an audition, a wipe: original left of this fraction, the audition right. */
  wipe?: number;
  /** 3.2: the container open on the graph canvas, per block (absent: the block's own graph). */
  opened: Record<string, string>;
}
export interface Audition {
  id: string; label: string; blockId: string; kinds: string[]; params?: (Record<string, ParamValue> | undefined)[]; recipe?: Recipe;
  /** Exact owned candidate: Apply installs these IDs so procedural noise cannot reroll. */
  candidate?: { projectId: string; base: Block; graph: BlockGraph; look?: ComponentDef };
}

export const uiStore = createStore<UiState>({
  ws: 'home',
  playhead: 30,
  playing: false,
  seconds: {},
  // Empty until the library loads (adoptFolders picks the first root); the old defaults named a
  // folder and a clip that never existed on any machine.
  folder: '',
  fxPanel: false,
  loupes: { A: { frame: 130 }, B: { frame: 410 } },
  snap: 'frame',
  sliceTarget: 'A',
  historyOpen: false,
  settingsPage: 'appearance',
  shortlist: [],
  opened: {},
});
export const useUi = <U>(sel: (s: UiState) => U) => useStore(uiStore, sel);
export const setUi = (patch: Partial<UiState>) => uiStore.set((s) => ({
  ...s, ...patch,
  ...(patch.ws === 'settings' && s.ws !== 'settings' ? { settingsReturn: s.ws } : {}),
}));

/**
 * The "test clips" favourite (the HD test footage), pinned once on a profile new or old, and only
 * when the folder exists on this machine (bug hunt: a dead favourite elsewhere); removing it sticks.
 */
export function seedTestClips(exists: boolean) {
  // A new supplied clip pack gets its own favourite once; removing that favourite still sticks.
  const key = TEST_CLIPS_DIR === 'D:\\td-media\\projects\\moshpit-v3\\test-footage' ? 'test-clips' : `test-clips:${TEST_CLIPS_DIR}`;
  if (!TEST_CLIPS_DIR || !exists || settingsStore.get().seeded.includes(key)) return;
  setSettings((s) => {
    if (!s.favourites.includes(TEST_CLIPS_DIR)) s.favourites = [TEST_CLIPS_DIR, ...s.favourites];
    s.favouriteNames = { ...s.favouriteNames, [TEST_CLIPS_DIR]: TEST_CLIPS_NAME };
    s.seeded = [...s.seeded, key];
  });
}

/** 3.2: open a container on the canvas (its graph replaces the block's until you go back), or close it. */
export function openContainer(blockId: string, container: string | null) {
  const opened = { ...uiStore.get().opened };
  if (container) opened[blockId] = container;
  else delete opened[blockId];
  setUi({ opened });
}

export function setWs(ws: WsId) {
  setUi({ ws });
}

export function toggleSettings() {
  const state = uiStore.get();
  setWs(state.ws === 'settings' ? state.settingsReturn ?? 'mosh' : 'settings');
}

export function setLoupe(which: 'A' | 'B', patch: Partial<UiState['loupes']['A']>) {
  uiStore.set((s) => ({ ...s, loupes: { ...s.loupes, [which]: { ...s.loupes[which], ...patch } } }));
}

export function toggleSeconds(key: string) {
  uiStore.set((s) => ({ ...s, seconds: { ...s.seconds, [key]: !s.seconds[key] } }));
}

// ---------- user / app settings (on disk) ----------

/** Design-system themes (DESIGN-SYSTEM.md §1.1): HUD is the default; only Layer 0 + 1 differ. */
export type ThemeId = 'hud' | 'studio' | 'heritage';

export interface AppSettings {
  theme: ThemeId;
  /** The former ✦ Notes toggle: outline panes and show their help on hover. */
  annotations: boolean;
  approxLabels: boolean;
  /** Auto shows a fast draft then refines paused Program; Full always requests working resolution. */
  previewResolution: 'auto' | 'full';
  uiScale: number;
  autosaveMin: number;
  paths: { media: string; output: string; cache: string; recipes: string; projects: string; freeze: string };
  /** codecV 2: H.264 became the factory codec (F3); a stored 'HAP' from before is read as the old default. */
  defaults: { codec: string; resolution: string; fps: string; proxyOnImport: boolean; codecV?: number; fpsV?: number };
  radial: { /** ms before a held radial accepts a flick (dead-zone arming). */ armMs: number };
  /** D7: re-check conformed clips when a project opens. */
  conformCheck: 'ask' | 'always' | 'never';
  /** The conform preset Import / conform uses: the speed ↔ smoothness trade-off (engine CONFORM_QUALITIES). */
  conformQuality: ConformQuality;
  /** Source browser Places: pinned folders, and the last folders opened (newest first). */
  favourites: string[];
  /** A pinned folder's display name, where it has one ("test clips"). */
  favouriteNames: Record<string, string>;
  /** One-time seeds already applied, so a removed default stays removed. */
  seeded: string[];
  /** The light tour: steps seen, skipped, and whether it was offered (first run). */
  tour: { seen: string[]; skipped: boolean; offered: boolean };
  recentFolders: string[];
  /** Source grid cell width (px): triage big, a known catalogue small. */
  gridCell: number;
  /** The workspace a launch opens on: HOME (default) or straight into Compose. */
  startOn: 'home' | 'compose';
  /** Compose's preset: Arrange (big timeline) or Process (big graph). */
  composeMode: 'arrange' | 'process';
  /** Phase 2.3: the effect browser renders each effect on the selected block (off: text only). */
  liveThumbs: boolean;
  /** Phase 2.6: favourite effects and recipes, by id (a node kind, or `recipe:<name>`). */
  effectFavs: string[];
  /** Phase 2.6: the user's own tags per effect id. They join the browser's search and filters. */
  effectTags: Record<string, string[]>;
  effectPresets: Record<string, { id: string; name: string; params: Record<string, ParamValue> }[]>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'hud',
  annotations: false,
  approxLabels: true,
  previewResolution: 'auto',
  uiScale: 1,
  autosaveMin: 3,
  paths: { media: '', output: '', cache: '', recipes: '', projects: '', freeze: '' },
  defaults: { codec: 'H.264', resolution: '1920×1080', fps: '60', proxyOnImport: true, codecV: 2, fpsV: 2 },
  radial: { armMs: 120 },
  conformCheck: 'ask',
  conformQuality: DEFAULT_CONFORM_QUALITY,
  favourites: [],
  favouriteNames: {},
  seeded: [],
  tour: { seen: [], skipped: false, offered: false },
  recentFolders: [],
  gridCell: 168,
  startOn: 'home',
  composeMode: 'arrange',
  liveThumbs: true,
  effectFavs: [],
  effectTags: {},
  effectPresets: {},
};

export const settingsStore = createStore<AppSettings>(DEFAULT_SETTINGS);
export const useSettings = <U>(sel: (s: AppSettings) => U) => useStore(settingsStore, sel);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let writes: Promise<void> = Promise.resolve();
export const settingsSaveStore = createStore<{ error?: string; saving: boolean; libraryEdit?: boolean }>({ saving: false });
export const useSettingsSave = () => useStore(settingsSaveStore, s => s);

function queueSettingsWrite(run: () => Promise<void>, durableLibraryEdit = false): Promise<void> {
  const next = writes.then(async () => {
    settingsSaveStore.set({ saving: true });
    try { await run(); settingsSaveStore.set({ saving: false }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settingsSaveStore.set({ saving: false, error: message, libraryEdit: durableLibraryEdit });
      toast(durableLibraryEdit ? 'Preset library change was not saved. Retry from the preset controls.' : 'Settings could not be saved. Your current settings remain in this session.', { kind: 'err', tag: 'settings-save', ...(durableLibraryEdit ? {} : { action: { label: 'Retry', run: () => { void flushSettings().catch(() => {}); } } }) });
      throw error;
    }
  });
  // A failed write must not poison the next attempt.
  writes = next.catch(() => {});
  return next;
}

export function flushSettings(): Promise<void> {
  clearTimeout(saveTimer);
  return queueSettingsWrite(async () => { await host.writeConfig('settings', structuredClone(settingsStore.get())); });
}

/** Durable library edits publish only after storage accepts them. Ordinary UI edits made while
 * the write is pending are retained and flushed behind it, never replaced by an old snapshot. */
export function updateSettingsDurably(mutate: (s: AppSettings) => void): Promise<void> {
  clearTimeout(saveTimer);
  return queueSettingsWrite(async () => {
    const base = settingsStore.get();
    const candidate = structuredClone(base);
    mutate(candidate);
    await host.writeConfig('settings', candidate);
    if (settingsStore.get() === base) settingsStore.set(candidate);
    else {
      const merged = structuredClone(settingsStore.get());
      mutate(merged);
      settingsStore.set(merged);
      scheduleSettingsSave();
    }
  }, true);
}

function scheduleSettingsSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushSettings().catch(() => {}); }, 400);
}
export function setSettings(mutate: (s: AppSettings) => void) {
  settingsStore.set((s) => {
    const next = structuredClone(s);
    mutate(next);
    return next;
  });
  scheduleSettingsSave();
}

export async function loadSettings() {
  const saved = (await host.readConfig('settings')) as Partial<AppSettings> | null;
  // The pre-release default media root ('D:\\td-media\\footage') never existed: read it as "engine default".
  if (saved?.paths?.media === 'D:\\td-media\\footage') saved.paths.media = '';
  // The pre-design-system themes (Mœbius / Slate / Ember) are gone: they read as the HUD default.
  if (saved && !['hud', 'studio', 'heritage'].includes(saved.theme as string)) saved.theme = 'hud';
  // F3 (UX round 2): HAP was the factory export codec until codecV 2; move that old default to H.264, once.
  if (saved?.defaults && !saved.defaults.codecV) saved.defaults = { ...saved.defaults, codec: saved.defaults.codec === 'HAP' ? 'H.264' : saved.defaults.codec, codecV: 2 };
  // Owner's C5 default: migrate the former factory 24 once; retain other saved rates and all project documents.
  if (saved?.defaults && !saved.defaults.fpsV) saved.defaults = { ...saved.defaults, fps: saved.defaults.fps === '24' ? '60' : saved.defaults.fps, fpsV: 2 };
  if (saved) saved.effectPresets = sanitizeEffectPresets(saved.effectPresets);
  if (saved) settingsStore.set({ ...DEFAULT_SETTINGS, ...saved, paths: { ...DEFAULT_SETTINGS.paths, ...saved.paths }, defaults: { ...DEFAULT_SETTINGS.defaults, ...saved.defaults }, radial: { ...DEFAULT_SETTINGS.radial, ...saved.radial } });
  if (settingsStore.get().startOn === 'compose' && uiStore.get().ws === 'home') setUi({ ws: 'mosh' });
}
