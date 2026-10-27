// The radial (pie) menu system — v3-node-radial-ux-study §3.1.
//  · ≤6 slices per ring, slots fixed clockwise from North (muscle memory), max 2 nested rings
//    below the root; a deeper choice hands off to a type-to-filter list, never another pie.
//  · Direction selects, not distance: each slice is an infinite wedge; a centre dead-zone
//    never fires; a click well outside the ring dismisses.
//  · South is Back in every sub-ring that has room; the centre, Backspace and right-click
//    also go back. Esc closes.
//  · Two speeds from one menu: click a slice (browse), or hold the key, flick, release (expert).
//    A short arming time ignores the release of the click that opened it.
//  · Accelerators: 1–6 by slot, the underlined letter, ←/→ + Enter.
// The same layer serves node-add and every preset / multi-choice picker (radialChoose).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createStore, useStore } from '../state/store';
import { settingsStore } from '../state/ui';
import { labelAt, radialLabelLines, sectorPath, sliceAt, slotAngle, slotCompass, southSlot } from './geometry';

export interface SearchItem {
  id: string;
  label: string;
  hint?: string;
  color?: string;
  group?: string;
  favourite?: boolean;
  run: () => void;
}

export interface SearchSpec {
  title: string;
  items: SearchItem[];
  placeholder?: string;
  /** A catalogue can supply the same intent ranking as its full browser. */
  filter?: (query: string) => SearchItem[];
}

export interface RadialItem {
  label: string;
  color?: string;
  icon?: string;
  /** Tooltip / status line. */
  hint?: string;
  disabled?: boolean;
  /** A sub-ring (level 2 at most). */
  children?: RadialItem[];
  /** Hand off to a type-to-filter list (the 3rd level). */
  search?: SearchSpec;
  run?: () => void;
  /** Marks the Back slot (always placed due South). */
  back?: boolean;
  /** Shows as the current value in a picker. */
  current?: boolean;
}

interface Level {
  title: string;
  items: RadialItem[];
  x: number;
  y: number;
}

interface RadialState {
  levels: Level[];
  search?: SearchSpec & { x: number; y: number };
  openedAt: number;
  /** Opened by a held key: releasing it fires the highlighted slice. */
  holdKey?: string;
  onCancel?: () => void;
  /** Phase 2.1a: Tab at any ring opens this list (type to filter), Houdini / Nuke style. */
  tabSearch?: SearchSpec;
}

const store = createStore<RadialState | null>(null);

const R_IN = 40;
const R_OUT = 122;
const DEAD = 32;
const SIZE = 300;

const clampPos = (x: number, y: number) => ({
  x: Math.max(SIZE / 2 + 6, Math.min(window.innerWidth - SIZE / 2 - 6, x)),
  y: Math.max(SIZE / 2 + 16, Math.min(window.innerHeight - SIZE / 2 - 6, y)),
});

/** A Back slot is added to every sub-ring that has room for one at South. */
export function withBack(items: RadialItem[], sub: boolean): RadialItem[] {
  if (!sub || items.length >= 6 || items.some((i) => i.back)) return items;
  const ring = [...items];
  // Even rings have a true South slot. Leave one inert spacer rather than moving Back to SW.
  if ((ring.length + 1) % 2) ring.push({ label: '—', disabled: true, hint: 'Unused direction' });
  const n = ring.length + 1;
  const s = southSlot(n);
  const back: RadialItem = { label: 'Back', back: true, color: 'var(--panel-3)', hint: 'Back to the previous ring (Backspace)' };
  ring.splice(s, 0, back);
  return ring;
}

export function openRadial(opts: { x: number; y: number; title: string; items: RadialItem[]; holdKey?: string; onCancel?: () => void; backSlot?: boolean; tabSearch?: RadialState['tabSearch'] }) {
  // backSlot: a ring that is also reachable as a sub-ring keeps its South slot when opened
  // directly, so every slice sits at the same compass point either way.
  const items = opts.backSlot ? withBack(opts.items, true) : opts.items;
  if (items.length > 6) throw new Error(`radial: ${items.length} slices (max 6) in "${opts.title}"`);
  const p = clampPos(opts.x, opts.y);
  store.set({ levels: [{ title: opts.title, items, ...p }], openedAt: performance.now(), holdKey: opts.holdKey, onCancel: opts.onCancel, tabSearch: opts.tabSearch });
}

export function closeRadial(cancelled = true) {
  const s = store.get();
  store.set(null);
  if (cancelled) s?.onCancel?.();
}

function back() {
  const s = store.get();
  if (!s) return;
  if (s.search) return store.set({ ...s, search: undefined });
  if (s.levels.length > 1) return store.set({ ...s, levels: s.levels.slice(0, -1) });
  closeRadial();
}

function activate(it: RadialItem, at?: { x: number; y: number }) {
  const s = store.get();
  if (!s || it.disabled) return;
  if (it.back) return back();
  const top = s.levels[s.levels.length - 1];
  // Sub-rings re-centre on the pointer, so the next flick is again a fresh compass gesture.
  const p = clampPos(at?.x ?? top.x, at?.y ?? top.y);
  if (it.children) {
    // Root + 2 nested rings at most (root → Add → Effect families); deeper hands off to search.
    if (s.levels.length >= 3) throw new Error('radial: a 3rd nested pie — hand off to search instead');
    return store.set({ ...s, levels: [...s.levels, { title: it.label, items: withBack(it.children, true), ...p }], openedAt: performance.now(), holdKey: undefined });
  }
  if (it.search) return store.set({ ...s, search: { ...it.search, x: top.x, y: top.y }, holdKey: undefined });
  closeRadial(false);
  it.run?.();
}

/** A one-ring (or two-ring) picker. Resolves with the chosen value, or undefined if cancelled. */
export interface PickOption<T> {
  label: string;
  value?: T;
  color?: string;
  hint?: string;
  children?: PickOption<T>[];
}
export function radialChoose<T>(at: { x: number; y: number }, title: string, options: PickOption<T>[], current?: T): Promise<T | undefined> {
  return new Promise((resolve) => {
    const map = (o: PickOption<T>): RadialItem => ({
      label: o.label,
      color: o.color ?? 'var(--lav)',
      hint: o.hint,
      current: o.value !== undefined && o.value === current,
      children: o.children?.map(map),
      run: o.children ? undefined : () => resolve(o.value),
    });
    openRadial({ x: at.x, y: at.y, title, items: options.map(map), onCancel: () => resolve(undefined) });
  });
}

/** Centre of an element, for pickers opened from a button (keyboard or mouse). */
export const centreOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

// ---------- accelerators ----------

/** One unique letter per slot, taken from the label; Back keeps B where possible. */
function accelerators(items: RadialItem[]): string[] {
  const used = new Set<string>();
  return items.map((it) => {
    const letters = (it.back ? 'b' : '') + it.label.toLowerCase().replace(/[^a-z]/g, '');
    const k = [...letters].find((c) => !used.has(c)) ?? '';
    if (k) used.add(k);
    return k;
  });
}

function Label({ text, accel }: { text: string; accel: string }) {
  const i = accel ? text.toLowerCase().indexOf(accel) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <tspan textDecoration="underline">{text[i]}</tspan>
      {text.slice(i + 1)}
    </>
  );
}

// ---------- the layer ----------

export function RadialLayer() {
  const s = useStore(store, (x) => x);
  const [hl, setHl] = useState(-1);
  const [ptr, setPtr] = useState<{ x: number; y: number } | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<Element | null>(null);
  const top = s?.levels[s.levels.length - 1];
  const keys = useMemo(() => (top ? accelerators(top.items) : []), [top]);

  // Focus in, focus back out (keyboard users land where they were).
  useLayoutEffect(() => {
    if (s && !restoreFocus.current) restoreFocus.current = document.activeElement;
    if (s && !s.search) overlay.current?.focus();
    if (!s && restoreFocus.current) {
      (restoreFocus.current as HTMLElement).focus?.();
      restoreFocus.current = null;
    }
  }, [s]);
  useEffect(() => setHl(top?.items.findIndex((i) => i.current) ?? -1), [top]);

  // Hold-key flick: releasing the key that opened the ring fires the highlighted slice.
  useEffect(() => {
    if (!s?.holdKey) return;
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== s.holdKey) return;
      const armed = performance.now() - s.openedAt > settingsStore.get().radial.armMs;
      if (armed && top && hl >= 0) activate(top.items[hl], ptr ?? undefined);
      else store.set((x) => (x ? { ...x, holdKey: undefined } : x)); // quick tap → stays open (sticky)
    };
    window.addEventListener('keyup', up);
    return () => window.removeEventListener('keyup', up);
  }, [s, top, hl, ptr]);

  if (!s || !top) return null;
  if (s.search) return <SearchPanel s={s} />;

  const n = top.items.length;
  const span = 360 / n;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const local = (x: number, y: number) => ({ dx: x - top.x, dy: y - top.y });

  const onMove = (e: React.PointerEvent) => {
    const { dx, dy } = local(e.clientX, e.clientY);
    setPtr({ x: e.clientX, y: e.clientY });
    setHl(sliceAt(dx, dy, n, DEAD));
  };
  const onUp = (e: React.PointerEvent) => {
    if (e.button === 2) return back();
    if (e.button !== 0) return;
    if (performance.now() - s.openedAt < settingsStore.get().radial.armMs) return; // the opening click's release
    const { dx, dy } = local(e.clientX, e.clientY);
    const d = Math.hypot(dx, dy);
    // Click browsing selects the drawn ring; held-key flicks keep their directional reach.
    if (d > R_OUT + 8) return closeRadial();
    const i = sliceAt(dx, dy, n, DEAD);
    if (i < 0) return back();
    activate(top.items[i], { x: e.clientX, y: e.clientY });
  };
  const onKey = (e: React.KeyboardEvent) => {
    // The menu owns the keyboard while open: Backspace must not reach React Flow's delete.
    e.stopPropagation();
    const k = e.key.toLowerCase();
    if (k === 'escape') return e.preventDefault(), closeRadial();
    if (k === 'backspace') return e.preventDefault(), back();
    if (k === 'tab') { e.preventDefault(); if (s.tabSearch) store.set({ ...s, search: { ...s.tabSearch, x: top.x, y: top.y }, holdKey: undefined }); return; }
    if (k === 'arrowright' || k === 'arrowdown') return e.preventDefault(), setHl((h) => (h + 1 + n) % n);
    if (k === 'arrowleft' || k === 'arrowup') return e.preventDefault(), setHl((h) => (h - 1 + n) % n);
    if ((k === 'enter' || k === ' ') && hl >= 0) return e.preventDefault(), activate(top.items[hl]);
    const num = Number(k);
    if (num >= 1 && num <= n) return e.preventDefault(), activate(top.items[num - 1]);
    const ai = keys.indexOf(k);
    if (ai >= 0 && k !== s.holdKey) return e.preventDefault(), activate(top.items[ai]);
  };

  const sub = s.levels.length > 1;
  const hlItem = hl >= 0 ? top.items[hl] : undefined;
  const ptrAngle = ptr ? (Math.atan2(ptr.x - top.x, -(ptr.y - top.y)) * 180) / Math.PI : 0;
  const ptrOut = ptr && Math.hypot(ptr.x - top.x, ptr.y - top.y) >= DEAD;
  return (
    <div
      ref={overlay}
      className="radialoverlay"
      tabIndex={-1}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKey}
      role="menu"
      aria-label={top.title}
      aria-activedescendant={hl >= 0 ? `radial-item-${hl}` : undefined}
    >
      <div className="radial2" style={{ left: top.x - SIZE / 2, top: top.y - SIZE / 2 }}>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE}>
          <text className="rtitle" x={cx} y={10}>{s.levels.map((l) => l.title).join(' › ')}</text>
          {top.items.map((it, i) => {
            const mid = slotAngle(i, n);
            const lp = labelAt(cx, cy, (R_IN + R_OUT) / 2, mid);
            const on = i === hl;
            const lines = radialLabelLines(it.label);
            const accelLine = lines.findIndex(line => line.toLowerCase().includes(keys[i]));
            return (
              <g
                key={it.label + i}
                id={`radial-item-${i}`}
                className={'rsect' + (on ? ' on' : '') + (it.disabled ? ' off' : '') + (it.back ? ' back' : '') + (it.current ? ' cur' : '')}
                role="menuitem"
                aria-label={`${it.label}${it.children || it.search ? ' (opens more)' : ''} — ${slotCompass(i, n)}`}
                aria-disabled={it.disabled}
              >
                <path d={sectorPath(cx, cy, R_IN, R_OUT, mid, span - 2.5)} fill={it.back ? 'var(--panel-3)' : it.color ?? 'var(--lav)'} />
                {it.icon && <text className="ricon" x={lp.x} y={lp.y - 11}>{it.icon}</text>}
                <text className="rlabel" x={lp.x} y={lp.y + (it.icon ? 4 : 0) - (lines.length - 1) * 6}>
                  {lines.map((line, row) => <tspan key={row} x={lp.x} dy={row ? 12 : 0}>
                    {row === 0 && it.back ? '‹ ' : ''}<Label text={line} accel={row === accelLine ? keys[i] : ''} />
                    {row === lines.length - 1 && (it.children || it.search) ? ' +' : ''}
                  </tspan>)}
                </text>
                <text className="rkey" x={lp.x} y={lp.y + (it.icon ? 16 : 13) + (lines.length - 1) * 6}>{i + 1}</text>
              </g>
            );
          })}
          {/* the direction disc (Blender): shows where a release would land */}
          <circle className="rdead" cx={cx} cy={cy} r={R_IN - 4} />
          {ptrOut && <line className="rdir" x1={cx} y1={cy} x2={labelAt(cx, cy, R_IN - 6, ptrAngle).x} y2={labelAt(cx, cy, R_IN - 6, ptrAngle).y} />}
          <text className="rcenter" x={cx} y={cy - 2}>{sub ? '‹ Back' : '✕'}</text>
          <text className="rcenter sm" x={cx} y={cy + 11}>{sub ? 'Bksp' : 'Esc'}</text>
          {s.tabSearch && <text className="rcenter sm" x={cx} y={cy + 22}>Tab ⌕</text>}
        </svg>
        {hlItem?.hint && <div className="rhint">{hlItem.hint}</div>}
      </div>
    </div>
  );
}

function SearchPanel({ s }: { s: RadialState }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sr = s.search!;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = sr.filter ? sr.filter(q) : needle ? sr.items.filter((it) => `${it.label} ${it.hint ?? ''} ${it.group ?? ''}`.toLowerCase().includes(needle)) : sr.items;
    return favouritesOnly ? matches.filter((it) => it.favourite) : matches;
  }, [q, sr, favouritesOnly]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setI(0), [q, favouritesOnly]);
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [i]);
  const pick = (it?: SearchItem) => {
    if (!it) return;
    closeRadial(false);
    it.run();
  };
  const W = Math.min(380, window.innerWidth - 12);
  const left = Math.max(6, Math.min(window.innerWidth - W - 6, sr.x - W / 2));
  const topY = Math.max(6, Math.min(window.innerHeight - 380, sr.y - 150));
  return (
    <div className="radialoverlay" onPointerDown={(e) => e.target === e.currentTarget && closeRadial()}>
      <div className="rsearch" style={{ left, top: topY, width: W }} role="dialog" aria-modal="true" aria-label={sr.title} onKeyDownCapture={e => {
        if (e.key !== 'Tab') return;
        const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
        if (!controls.length) return;
        e.preventDefault(); e.stopPropagation();
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); closeRadial(); } }}>
        <div className="rsh">
          <button className="rsback" onClick={back} title="Back to the ring (Backspace on an empty field)">‹</button>
          <b>{sr.title}</b>
          {sr.items.some((it) => it.favourite) && <button className="rsfavs" aria-pressed={favouritesOnly} onClick={() => { setFavouritesOnly((v) => !v); input.current?.focus(); }}>★ Favourites</button>}
          <span className="dim">{shown.length}</span>
        </div>
        <input
          ref={input}
          value={q}
          placeholder={sr.placeholder ?? 'type to filter…'}
          aria-label={`Filter ${sr.title}`}
          role="combobox"
          aria-expanded="true"
          aria-controls="radial-search-results"
          aria-autocomplete="list"
          aria-activedescendant={shown[i] ? `radial-result-${i}` : undefined}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') (e.preventDefault(), setI((x) => Math.min(shown.length - 1, x + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
            else if (e.key === 'Enter') (e.preventDefault(), pick(shown[i]));
            else if (e.key === 'Escape') (e.preventDefault(), closeRadial());
            else if (e.key === 'Backspace' && !q) (e.preventDefault(), back());
          }}
        />
        <div className="rslist" ref={list} role="listbox" id="radial-search-results" aria-label={sr.title}>
          {shown.map((it, k) => (
            <div key={it.id} id={`radial-result-${k}`} role="option" aria-selected={k === i} className={'rsitem' + (k === i ? ' on' : '')} onMouseEnter={() => setI(k)} onClick={() => pick(it)}>
              <span className="d" style={{ background: it.color ?? 'var(--lav)' }} />
              <span className="rsl">{it.favourite ? '★ ' : ''}{it.label}{it.hint && <small>{it.hint}</small>}</span>
              {it.group && <span className="ftag">{it.group}</span>}
            </div>
          ))}
          {!shown.length && <div className="chapempty">Nothing matches “{q}”.</div>}
        </div>
        <div className="rsfoot">↑↓ choose · Enter add · Backspace back · Esc close</div>
      </div>
    </div>
  );
}
