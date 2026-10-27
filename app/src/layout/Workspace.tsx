import { Fragment, useMemo, type ReactNode } from 'react';
import { SharedPane } from '../../../shared/ui/AppShell';
import { SharedResizeHandle } from '../../../shared/ui/ResizeHandle';
import type { WsId } from '../state/ui';
import { useSettings } from '../state/ui';
import { createStore, useStore } from '../state/store';
import { PaneBoundary } from '../qol/qol';
import { InfoPane } from '../qol/InfoPane';
import { LIMITS, dropPane, patchCol, patchStack, sanitize, setWsLayout, untab, useLayouts, type ColumnLayout, type DropTarget, type StackLayout, type WsLayout } from './model';

export interface PaneDef {
  title: string;
  /** Mosh mode's numbered panes (1 preview, 2 slice, 3 edit). */
  num?: string;
  /** Teal provenance badge, e.g. "EDENA". */
  built?: string;
  /** What the pane does: shown on hover over its title (no ⓘ badge). */
  help?: string;
  /** A secondary pane (history, metadata, chapters…): only these get a collapse control. */
  minor?: boolean;
  /** Header content right of the title (status, controls). */
  extra?: ReactNode;
  /** Rendered only while visible (active tab, not collapsed). */
  body: () => ReactNode;
}

/** The pane being re-docked, the cursor, and the drop key under it. */
interface DockDrag {
  pane: string;
  title: string;
  x: number;
  y: number;
  over: string | null;
}
const dragStore = createStore<DockDrag | null>(null);

/**
 * Pointer-driven re-dock (not HTML5 DnD: no OS drag ghost, and it works under synthetic input).
 * Drop targets are any element with data-drop="<json DropTarget>".
 */
function startDock(e: React.PointerEvent, pane: string, title: string, onDrop: (pane: string, to: DropTarget) => void) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let live = false;
  const targetAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('[data-drop]') as HTMLElement | null)?.dataset.drop ?? null;
  const move = (ev: PointerEvent) => {
    if (!live && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    live = true;
    dragStore.set({ pane, title, x: ev.clientX, y: ev.clientY, over: targetAt(ev.clientX, ev.clientY) });
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', esc);
    if (!live) return;
    const over = targetAt(ev.clientX, ev.clientY);
    dragStore.set(null);
    if (over) onDrop(pane, JSON.parse(over));
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    live = false;
    dragStore.set(null);
    up(new PointerEvent('pointerup'));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', esc);
}

export function Workspace({ ws, panes }: { ws: WsId; panes: Record<string, PaneDef> }) {
  const known = useMemo(() => Object.keys(panes), [panes]);
  const stored = useLayouts((s) => s.current[ws]);
  const cols = useMemo(() => sanitize(stored, ws, known), [stored, ws, known]);
  const dragging = useStore(dragStore, (s) => s);
  const update = (fn: (c: WsLayout) => WsLayout) => setWsLayout(ws, fn, known);
  const plain = cols.filter((c) => !c.band);
  const band = cols.find((c) => c.band);

  const drop = (pane: string, to: DropTarget) => {
    if (panes[pane]) update((c) => dropPane(c, pane, to));
  };
  const lane = (c: ColumnLayout) => <Lane c={c} panes={panes} update={update} drop={drop} drag={dragging} />;

  return (
    <div className={'stage ws-' + ws + (dragging ? ' docking' : '')}>
      <div className="stagecols">
        {plain.map((c, ci) => (
          <Fragment key={c.id}>
            {ci > 0 && (
              <SharedResizeHandle
                className="vsplit"
                orientation="vertical"
                label="Resize columns"
                title="Drag to resize columns"
                onResizeStart={() => {
                  // Resize the fixed-width neighbour; the flexible main column takes the rest.
                  const fixed = plain[ci - 1].w !== undefined ? plain[ci - 1] : c;
                  const sign = fixed === c ? -1 : 1;
                  const start = fixed.w ?? 260;
                  return (dx) => update((l) => patchCol(l, fixed.id, { w: Math.max(LIMITS.colMin, Math.min(LIMITS.colMax, start + sign * dx)) }));
                }}
              />
            )}
            <div className={'wcol' + (c.w === undefined ? ' main' : '')} data-col={c.id} style={c.w !== undefined ? { flex: `0 0 ${c.w}px` } : undefined}>
              {lane(c)}
              {ci === 0 && <InfoPane />}
            </div>
          </Fragment>
        ))}
      </div>
      {band && (
        <>
          <SharedResizeHandle
            className="hsplit"
            orientation="horizontal"
            label="Resize the arrangement"
            title="Drag to resize the arrangement"
            onResizeStart={(element) => {
              const stage = (element.parentElement as HTMLElement).getBoundingClientRect().height;
              const start = band.h ?? 0.3;
              return (_dx, dy) => update((l) => patchCol(l, band.id, { h: Math.max(LIMITS.bandMin, Math.min(LIMITS.bandMax, start - dy / stage)) }));
            }}
          />
          <div className="wband" style={{ flex: `0 0 ${(band.h ?? 0.3) * 100}%` }}>
            {lane(band)}
          </div>
        </>
      )}
      {dragging && (
        <div className="dockghost" style={{ left: dragging.x + 12, top: dragging.y + 10 }}>
          {dragging.title} {dragging.over ? (JSON.parse(dragging.over).mode === 'tab' ? '→ tab' : '→ stack') : ''}
        </div>
      )}
    </div>
  );
}

/**
 * A column's stacks top to bottom, or the band's left to right. Stacks share the space by weight
 * (never by pixels), so the lane always fits its region; the splitter between two stacks moves
 * weight from one to the other.
 */
function Lane({ c, panes, update, drop, drag }: { c: ColumnLayout; panes: Record<string, PaneDef>; update: (fn: (c: WsLayout) => WsLayout) => void; drop: (pane: string, to: DropTarget) => void; drag: DockDrag | null }) {
  const horiz = !!c.band;
  return (
    <div className={'lane' + (horiz ? ' h' : '')}>
      {c.stacks.map((s, i) => {
        const next = c.stacks[i + 1];
        return (
          <Fragment key={s.id}>
            <DropZone drag={drag} to={{ col: c.id, mode: 'before', stack: s.id }} />
            <Stack s={s} col={c.id} panes={panes} update={update} drop={drop} drag={drag} />
            {next && !s.collapsed && !next.collapsed && s.f !== 0 && next.f !== 0 && (
              <SharedResizeHandle
                className={horiz ? 'stacksplit h' : 'stacksplit'}
                orientation={horiz ? 'vertical' : 'horizontal'}
                label="Resize panes"
                title="Drag to resize"
                onResizeStart={(element) => {
                  const a = (element.previousElementSibling as HTMLElement).getBoundingClientRect();
                  const b = (element.nextElementSibling?.nextElementSibling as HTMLElement).getBoundingClientRect();
                  const [sa, sb] = horiz ? [a.width, b.width] : [a.height, b.height];
                  const total = (s.f ?? 1) + (next.f ?? 1);
                  return (dx, dy) => {
                    const na = Math.max(LIMITS.stackMin, Math.min(sa + sb - LIMITS.stackMin, sa + (horiz ? dx : dy)));
                    const fa = (total * na) / (sa + sb);
                    update((l) => patchStack(patchStack(l, s.id, { f: fa }), next.id, { f: total - fa }));
                  };
                }}
              />
            )}
          </Fragment>
        );
      })}
      <DropZone drag={drag} end to={{ col: c.id, mode: 'before' }} />
    </div>
  );
}

/** The 1px gutter between stacks; while re-docking it becomes a wider drop target without moving anything. */
function DropZone({ drag, end, to }: { drag: DockDrag | null; end?: boolean; to: DropTarget }) {
  const key = JSON.stringify(to);
  const over = drag?.over === key;
  return <div className={'dropzone' + (drag ? ' live' : '') + (over ? ' over' : '') + (end ? ' end' : '')} data-drop={drag ? key : undefined} />;
}

function Stack({ s, col, panes, update, drop, drag }: { s: StackLayout; col: string; panes: Record<string, PaneDef>; update: (fn: (c: WsLayout) => WsLayout) => void; drop: (pane: string, to: DropTarget) => void; drag: DockDrag | null }) {
  const annotations = useSettings((x) => x.annotations);
  const activeId = s.panes[s.active] ?? s.panes[0];
  const p = panes[activeId];
  const tabbed = s.panes.length > 1;
  const tabKey = JSON.stringify({ col, mode: 'tab', stack: s.id } satisfies DropTarget);
  const canTab = !!drag && !s.panes.includes(drag.pane);

  return (
    <SharedPane
      className={'card' + (s.collapsed ? ' collapsed' : '') + (annotations ? ' anno annoglow' : '')}
      style={s.collapsed ? undefined : s.f === 0 ? { flex: '0 0 auto', maxHeight: '50%' } : { flex: `${s.f ?? 1} 1 0px` }}
      title={p.title}
      collapsed={s.collapsed}
      bodyClassName="pbody"
      beforeHeader={annotations && p.help && (
        <div className="tip">
          <b>{p.title}</b>
          {p.help}
        </div>
      )}
      header={<div className={'hd' + (canTab && drag?.over === tabKey ? ' tabover' : '')} data-drop={canTab ? tabKey : undefined}>
        {tabbed ? (
          <div className="ptabs" role="tablist">
            {s.panes.map((id, i) => (
              <button
                key={id}
                role="tab"
                aria-selected={i === s.active}
                className={i === s.active ? 'on' : ''}
                onPointerDown={(e) => startDock(e, id, panes[id].title, drop)}
                onClick={() => update((c) => patchStack(c, s.id, { active: i, collapsed: false }))}
                title={`${panes[id].help ? panes[id].help + ' · ' : ''}Click to show, drag to re-dock`}
              >
                {panes[id].title}
              </button>
            ))}
          </div>
        ) : (
          <span className="grab" onPointerDown={(e) => startDock(e, activeId, p.title, drop)} title={`${p.help ? p.help + ' · ' : ''}Drag the title to re-dock it`}>
            {p.num && <span className="paneno">{p.num}</span>}
            <span className="ttl">{p.title}</span>
          </span>
        )}
        {p.built && <span className="built">{p.built}</span>}
        <span className="spacer" />
        {/* Live state stays on the header when the pane is collapsed (Arena-style accordions). */}
        {p.extra}
        <span className="panetools">
          {tabbed && (
            <button title="Separate these tabs back into stacked panes" onClick={() => update((c) => untab(c, s.id))}>⇲</button>
          )}
          {/* Collapse only where it helps: main panes (viewers, timeline, graph, inspector) stay open. */}
          {(p.minor || s.collapsed) && (
            <button title={s.collapsed ? 'Expand pane' : 'Collapse pane'} aria-expanded={!s.collapsed} onClick={() => update((c) => patchStack(c, s.id, { collapsed: !s.collapsed }))}>
              {s.collapsed ? '▸' : '▾'}
            </button>
          )}
        </span>
      </div>}
    >
      {!s.collapsed && <PaneBoundary key={activeId} name={p.title}>{p.body()}</PaneBoundary>}
    </SharedPane>
  );
}
