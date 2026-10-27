// Workspace layout model. A workspace is columns, plus at most one full-width band under them
// (Compose's arrangement); a column is a vertical list of stacks, the band a horizontal one; a
// stack holds one pane, or several as tabs ("tabbed but default-separated"). Every size is
// bounded and relative to the viewport, so a workspace never grows taller than the window and
// the shell never scrolls (usability plan, locked decision 1). Layouts are user config, saved
// to disk (L13), never to the project.
import type { WsId } from '../state/ui';
import { createStore, useStore } from '../state/store';
import { host } from '../host';
import { toastError } from '../qol/qol';

export interface StackLayout {
  id: string;
  panes: string[];
  active: number;
  /** Share of its column (or band) next to its siblings; default 1. 0 = its content's height (a form), capped at half the column. */
  f?: number;
  collapsed?: boolean;
}

export interface ColumnLayout {
  id: string;
  /** Pixel width; undefined = the flexible main column. Ignored for the band. */
  w?: number;
  /** The full-width row under the columns. Its stacks sit side by side. */
  band?: boolean;
  /** Band only: share of the workspace height, 0–1. */
  h?: number;
  stacks: StackLayout[];
}

export type WsLayout = ColumnLayout[];

export interface SavedLayout {
  name: string;
  ws: WsId;
  layout: WsLayout;
}

const st = (pane: string | string[], f = 1): StackLayout => {
  const panes = Array.isArray(pane) ? pane : [pane];
  return { id: 's-' + panes[0], panes, active: 0, f };
};
const col = (id: string, w: number | undefined, stacks: StackLayout[]): ColumnLayout => ({ id, w, stacks });
const band = (id: string, h: number, stacks: StackLayout[]): ColumnLayout => ({ id, band: true, h, stacks });

/** Bounds every resize respects. */
export const LIMITS = { colMin: 160, colMax: 560, bandMin: 0.16, bandMax: 0.62, stackMin: 56 };

/**
 * The default per-workspace layouts: the Layout Law (plan §2) — LEFT input, CENTRE the work,
 * RIGHT output / inspector — with Compose's arrangement as the full-width band (plan §6).
 */
export const DEFAULT_LAYOUTS: Record<WsId, WsLayout> = {
  // COMPOSE (restructure v2, Waxy's sign-off): LEFT clips + the A/B slots (each slices) · CENTRE the
  // program preview with its transport on top, the arrangement, the node graph (Arrange weights;
  // Process swaps arrangement 15 / graph 35) · RIGHT the separate node preview and the inspector.
  // History is a drawer; Audio Mirror, Render mini and the standalone slice tier are gone.
  // UX round 2 grid, proportioned to content (Waxy): a slim dock (A over B, clips below), the
  // Inspector desk A: resident chain/parameters right; requested detail claims centre space.
  mosh: [
    col('dock', 240, [st(['clips', 'library', 'slots'])]),
    col('main', undefined, [st('program', 3), st('edit', 0), { ...st(['detail', 'graph', 'block', 'render'], 1), collapsed: true }]),
    col('inspect', 340, [st('effects')]),
  ],
  // Open Graph on the selected block (plan §6.3): reached from Compose, not a peer workspace
  node: [
    col('lib', 210, [st('nodelib')]),
    col('main', undefined, [st('canvas', 5), st('mini', 1), st('lfo', 2)]),
    col('dock', 280, [st('nodeviewer', 2), st('output', 2), st('ninspector', 3)]),
  ],
  // IN: Places above the folder/clip browser; source picture and marks stay central.
  // The flexible preview/slicer stays central, with selection and metadata on the right.
  browse: [
    col('browser', 300, [st('places', 1), st('browser', 4)]),
    col('main', undefined, [st('bigpv')]),
    col('clip', 320, [st('convert', 2), st(['meta', 'chapters'], 1)]),
  ],
  render: [
    col('settings', 300, [st('presets', 1), st('addjob', 3)]),
    col('main', undefined, [st('preview')]),
    col('jobs', 320, [st('queue', 3), st('log', 1)]),
  ],
  settings: [col('nav', 210, [st('setnav')]), col('main', undefined, [st('prefs')])],
  // HOME: LEFT start + folders · CENTRE recent projects over the workspaces · RIGHT system, session, keys.
  home: [
    col('hleft', 260, [st('hstart', 0), st('hplaces', 1)]),
    col('main', undefined, [st('hprojects', 3), st('hjump', 0)]),
    col('hright', 300, [st('hsys', 0), st('hsession', 0), st('hkeys', 1)]),
  ],
};

// ---------- pure ops ----------

/** Join the old folder/clip panes without discarding a customised preview or saved layout. */
export function migrateBrowseLayout(stored: WsLayout): WsLayout {
  const all = stored.flatMap(c => c.stacks.flatMap(s => s.panes));
  if (!all.some(p => p === 'tree' || p === 'grid')) return stored;
  const anchor = all.includes('browser') ? 'browser' : all.includes('grid') ? 'grid' : 'tree';
  let claimed = false;
  const cols = stored.map(c => ({ ...c, stacks: c.stacks.map(s => {
    const activePane = s.panes[s.active];
    const panes = s.panes.flatMap(p => {
      if (p === anchor && !claimed) { claimed = true; return ['browser']; }
      return ['tree', 'grid', 'browser'].includes(p) ? [] : [p];
    });
    return { ...s, panes, active: Math.max(0, panes.indexOf(activePane === anchor ? 'browser' : activePane)) };
  }).filter(s => s.panes.length) })).filter(c => c.stacks.length);
  const together = cols.findIndex(c => c.stacks.some(s => s.panes.includes('browser')) && c.stacks.some(s => s.panes.includes('places')));
  if (together >= 0) {
    const c = cols[together];
    cols[together] = { ...c, stacks: c.stacks.map(s => {
      const panes = s.panes.filter(p => p !== 'places');
      return { ...s, panes, active: Math.max(0, panes.indexOf(s.panes[s.active])) };
    }).filter(s => s.panes.length) };
    const ids = new Set(cols.map(c => c.id));
    let id = 'places'; while (ids.has(id)) id += '-rail';
    cols.splice(together, 0, col(id, 176, [st('places')]));
  }
  return cols;
}

export function removePane(cols: WsLayout, pane: string): WsLayout {
  return cols.map((c) => ({
    ...c,
    stacks: c.stacks
      .map((s) => {
        const i = s.panes.indexOf(pane);
        if (i < 0) return s;
        const panes = s.panes.filter((p) => p !== pane);
        return { ...s, panes, active: Math.min(s.active > i ? s.active - 1 : s.active, panes.length - 1) };
      })
      .filter((s) => s.panes.length),
  }));
}

export type DropTarget = { col: string; mode: 'tab'; stack: string } | { col: string; mode: 'before'; stack?: string };

/** Move a pane: into a stack as a tab, or as its own stack before `stack` (end of column if absent). */
export function dropPane(cols: WsLayout, pane: string, to: DropTarget): WsLayout {
  const srcStack = cols.flatMap((c) => c.stacks).find((s) => s.panes.includes(pane));
  if (!srcStack) return cols;
  if (to.mode === 'tab' && to.stack === srcStack.id) return cols;
  const next = removePane(cols, pane);
  return next.map((c) => {
    if (c.id !== to.col) return c;
    if (to.mode === 'tab') {
      return { ...c, stacks: c.stacks.map((s) => (s.id === to.stack ? { ...s, panes: [...s.panes, pane], active: s.panes.length } : s)) };
    }
    const fresh: StackLayout = { id: `s-${pane}-${Date.now().toString(36)}`, panes: [pane], active: 0, f: srcStack.f };
    const at = to.stack ? c.stacks.findIndex((s) => s.id === to.stack) : -1;
    const stacks = [...c.stacks];
    stacks.splice(at < 0 ? stacks.length : at, 0, fresh);
    return { ...c, stacks };
  });
}

/** Split a tabbed stack back into one stack per pane (the default-separated state). */
export function untab(cols: WsLayout, stackId: string): WsLayout {
  return cols.map((c) => ({
    ...c,
    stacks: c.stacks.flatMap((s) => (s.id !== stackId ? [s] : s.panes.map((p, i) => ({ id: i ? `s-${p}-${Date.now().toString(36)}` : s.id, panes: [p], active: 0, f: s.f })))),
  }));
}

export const patchStack = (cols: WsLayout, stackId: string, patch: Partial<StackLayout>): WsLayout =>
  cols.map((c) => ({ ...c, stacks: c.stacks.map((s) => (s.id === stackId ? { ...s, ...patch } : s)) }));

export const patchCol = (cols: WsLayout, colId: string, patch: Partial<ColumnLayout>): WsLayout =>
  cols.map((c) => (c.id === colId ? { ...c, ...patch } : c));

/**
 * Reconcile a stored layout with the panes this build has: unknown panes are dropped, new ones
 * are added where the default puts them. Keeps old saved layouts loading after app updates.
 */
export function sanitize(stored: WsLayout | undefined, ws: WsId, known: string[]): WsLayout {
  const def = DEFAULT_LAYOUTS[ws];
  if (!stored?.length) return def;
  if (ws === 'browse' && known.includes('browser')) stored = migrateBrowseLayout(stored);
  let cols: WsLayout = stored.map((c) => ({
    ...c,
    stacks: c.stacks
      .map((s) => {
        const panes = s.panes.filter((p) => known.includes(p));
        return { ...s, panes, active: Math.max(0, Math.min(s.active, panes.length - 1)) };
      })
      .filter((s) => s.panes.length),
  }));
  const present = new Set(cols.flatMap((c) => c.stacks.flatMap((s) => s.panes)));
  for (const p of known) {
    if (present.has(p)) continue;
    const home = def.find((c) => c.stacks.some((s) => s.panes.includes(p)))?.id;
    const target = cols.find((c) => c.id === home) ?? cols.filter((c) => !c.band).at(-1) ?? cols[0];
    const f = def.flatMap((c) => c.stacks).find((s) => s.panes.includes(p))?.f;
    cols = cols.map((c) => (c === target ? { ...c, stacks: [...c.stacks, st(p, f)] } : c));
  }
  // An emptied column goes; one column always flexes.
  cols = cols.filter((c) => c.stacks.length || !c.band);
  const plain = cols.filter((c) => !c.band);
  if (plain.length && !plain.some((c) => c.w === undefined)) {
    const m = plain[Math.min(1, plain.length - 1)];
    cols = cols.map((c) => (c === m ? { ...c, w: undefined } : c));
  }
  return cols;
}

// ---------- store + persistence ----------

interface LayoutState {
  current: Partial<Record<WsId, WsLayout>>;
  saved: SavedLayout[];
}

/** v2 = bounded, viewport-relative stacks; v3/v4 = the Phase C Source layouts. Older files load as the defaults. */
export const LAYOUT_VERSION = 8; // v8: Places rail and combined browser; v7 custom workspaces migrate in place

export const layoutStore = createStore<LayoutState>({ current: {}, saved: [] });
export const useLayouts = <U>(sel: (s: LayoutState) => U) => useStore(layoutStore, sel);

let timer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => void host.writeConfig('layouts', { v: LAYOUT_VERSION, ...layoutStore.get() }).catch(toastError), 400);
}

export function setWsLayout(ws: WsId, fn: (cols: WsLayout) => WsLayout, known: string[]) {
  layoutStore.set((s) => ({ ...s, current: { ...s.current, [ws]: fn(sanitize(s.current[ws], ws, known)) } }));
  persist();
}

export function resetWsLayout(ws: WsId) {
  layoutStore.set((s) => {
    const current = { ...s.current };
    delete current[ws];
    return { ...s, current };
  });
  persist();
}

export function saveLayout(name: string, ws: WsId) {
  layoutStore.set((s) => ({ ...s, saved: [...s.saved.filter((l) => l.name !== name), { name, ws, layout: s.current[ws] ?? DEFAULT_LAYOUTS[ws] }] }));
  persist();
}

export function applySaved(l: SavedLayout) {
  layoutStore.set((s) => ({ ...s, current: { ...s.current, [l.ws]: structuredClone(l.layout) } }));
  persist();
}

export function deleteSaved(name: string) {
  layoutStore.set((s) => ({ ...s, saved: s.saved.filter((l) => l.name !== name) }));
  persist();
}

/**
 * Loads the stored layouts. On a version bump the workspaces reset to the new defaults, but NAMED
 * saved layouts are kept (sanitize fits them to the current panes when applied) and the returned
 * notice says so: they used to vanish silently (P2, audit).
 */
export async function loadLayouts(): Promise<string | undefined> {
  const raw = (await host.readConfig('layouts')) as (Partial<LayoutState> & { v?: number }) | null;
  if (!raw || typeof raw !== 'object') return;
  const saved = Array.isArray(raw.saved) ? raw.saved : [];
  if (raw.v === LAYOUT_VERSION) return void layoutStore.set({ current: raw.current ?? {}, saved });
  if (raw.v === 7) {
    const current = { ...raw.current };
    if (current.browse) current.browse = migrateBrowseLayout(current.browse);
    layoutStore.set({ current, saved });
    persist();
    return;
  }
  layoutStore.set({ current: {}, saved });
  persist();
  return `Workspaces reset to the new layout${saved.length ? `; your ${saved.length} saved layout${saved.length > 1 ? 's were' : ' was'} kept` : ''}.`;
}
