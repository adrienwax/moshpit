import { useMemo } from 'react';
import type { NodeCategory, NodeDef } from '@moshpit/engine';
import { LFO_SHAPES, NODE_CATEGORIES, VALUE_CURVES, isPlaceable, mapValue } from '@moshpit/engine';
import { defOf as nodeDefsOf, nodeDefs } from '../../engine';
import { CATS, FAMILY_COLOUR } from '../../lib/cats';
import { beatsToSec, timecode, barsBeats } from '../../lib/time';
import { blockFrames, blockStarts } from '../../lib/timeline';
import { addLfo, addNode, addValue, linkParam, linkValue, lfoLinks, removeValue, selectBlock, setLfo, setLinkDepth, setValue, setValueLink, unlinkParam, unlinkValue, useProject, valueLinks } from '../../state/project';
import { setUi, useUi, useSettings } from '../../state/ui';
import { selectNode, undoAction } from '../../state/project';
import { browse, entries } from '../../lib/browse';
import { ParamControl } from '../../params/Param';
import { canvasBridge } from './GraphCanvas';
import { RadialPick } from '../../radial/RadialPick';
import { chainOrder, nodeLabel, useActive } from '../../components/nodes';
import { Empty, toast, toastError } from '../../qol/qol';
import { createStore, useSticky, useStore } from '../../state/store';

// ---------- node library ----------

const libDrag = createStore<{ def: NodeDef; x: number; y: number } | null>(null);

function placeFromLibrary(def: NodeDef, blockId: string, position?: { x: number; y: number }) {
  const bridge = canvasBridge.get();
  if (!bridge || (typeof bridge.at === 'string' ? bridge.at : bridge.at.blockId) !== blockId) return;
  try {
    const id = addNode(bridge.at, def.kind, position ?? bridge.center());
    selectNode(blockId as never, id);
    toast(`Added ${def.label}`, { kind: 'ok', action: undoAction() });
  } catch (err) { toastError(err); }
}

/** Click adds at the canvas centre; drag drops where you let go (pointer-driven, like re-docking). */
function startLibDrag(e: React.PointerEvent, def: NodeDef, blockId: string) {
  if (e.button !== 0) return;
  e.preventDefault();
  const bridge = canvasBridge.get();
  if (!bridge) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let live = false;
  const move = (ev: PointerEvent) => {
    if (!live && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    live = true;
    libDrag.set({ def, x: ev.clientX, y: ev.clientY });
  };
  const cancel = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('keydown', key);
    libDrag.set(null);
  };
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') cancel(); };
  const up = (ev: PointerEvent) => {
    cancel();
    if (canvasBridge.get() !== bridge || ev.button !== 0) return;
    const at = live ? bridge?.flowAt(ev.clientX, ev.clientY) : bridge?.center();
    if (live && !at) return; // dropped outside the canvas
    placeFromLibrary(def, blockId, at ?? undefined);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', key);
}

export function LibDragGhost() {
  const d = useStore(libDrag, (s) => s);
  if (!d) return null;
  return <div className="dockghost" style={{ left: d.x + 12, top: d.y + 10, borderColor: CATS[d.def.category].accent }}>{CATS[d.def.category].icon} {d.def.label}</div>;
}

export function NodeLibrary() {
  const [q, setQ] = useSticky('nodelib.q', '');
  const { block } = useActive();
  const defs = nodeDefs().filter(isPlaceable);
  const tags = useSettings(s => s.effectTags);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = browse(entries(defs).filter(e => e.type === 'node'), { q, meta: { tags } }).flatMap(g => g.items.map(e => e.id));
    const ranks = new Map(matches.map((id, i) => [id, i]));
    const hit = (d: NodeDef) => !needle || ranks.has(d.kind) || `${d.label} ${d.blurb} ${d.family ?? ''} ${d.category}`.toLowerCase().includes(needle);
    return NODE_CATEGORIES.map((cat) => ({ cat, items: defs.filter((d) => d.category === cat && hit(d)).sort((a, b) => needle ? (ranks.get(a.kind) ?? 999) - (ranks.get(b.kind) ?? 999) : 0) })).filter((g) => g.items.length);
  }, [q, defs, tags]);
  return (
    <div className="nlib2">
      <div className="nsearch"><input placeholder={`search ${defs.length} nodes…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search nodes" /></div>
      {groups.map(({ cat, items }) => (
        <LibGroup key={cat} cat={cat} items={items} blockId={block?.id} />
      ))}
      {!groups.length && <Empty icon="⌕" title={`No node matches “${q}”`} cta={{ label: 'Clear search', run: () => setQ('') }}>Search looks at names and descriptions.</Empty>}
      <div className="ngrp">
        <div className="gh"><span className="cbadge2" style={{ color: 'var(--txt-3)', borderColor: 'var(--line-2)' }}>⚠</span>Legacy<span className="ct">on load</span></div>
        <div className="gi"><div className="ni legacy" title="Nodes from an older version load greyed and locked until migrated (D6) — never silently, never a crash"><span className="d" style={{ background: 'var(--line-2)' }} />Older-version nodes<span className="ptag">legacy</span></div></div>
      </div>
      <div className="footnote" style={{ margin: 0 }}>Click or Enter to add at centre · drag onto the canvas · Esc cancels a drag</div>
    </div>
  );
}

function LibGroup({ cat, items, blockId }: { cat: NodeCategory; items: NodeDef[]; blockId?: string }) {
  const [open, setOpen] = useSticky(`nodelib.open.${cat}`, true);
  const C = CATS[cat];
  const reserved = cat === 'Audio';
  return (
    <div className="ngrp">
      <button className="gh" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="cbadge2" style={{ color: C.accent, borderColor: C.accent }}>{C.icon}</span>
        {cat}
        <span className="ct">{items.length} {open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="gi">
          {items.map((d) => (
            <div
              key={d.kind}
              className={'ni' + (reserved ? ' planned' : '')}
              role="button"
              tabIndex={reserved || !blockId ? -1 : 0}
              aria-disabled={reserved || !blockId}
              onKeyDown={e => { if (!reserved && blockId && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) placeFromLibrary(d, blockId); } }}
              title={`${d.blurb}${d.impl.preview === 'PROXY' ? ' · preview ≈ proxy, export exact' : ''}`}
              onPointerDown={reserved || !blockId ? undefined : (e) => startLibDrag(e, d, blockId)}
            >
              <span className="d" style={{ background: d.family ? FAMILY_COLOUR[d.family] : C.accent }} />
              {d.label}
              {d.impl.preview === 'PROXY' && <span className="approx" style={{ fontSize: 9 }}> ≈</span>}
              {d.family && cat === 'Effect' && <span className="ftag">{d.family}</span>}
              {reserved ? <span className="ptag">reserved</span> : <span className="run" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- project LFOs (L8) ----------

const SHAPE_PATH: Record<string, string> = {
  sine: 'M0 6 Q4 0 8 6 T16 6',
  ramp: 'M0 11 L8 1 L8 11 L16 1',
  square: 'M0 11 L0 1 L8 1 L8 11 L16 11 L16 1',
  triangle: 'M0 11 L4 1 L8 11 L12 1 L16 11',
};
export const WaveIcon = ({ shape }: { shape: string }) => (
  <svg viewBox="0 0 16 12" aria-hidden><path d={SHAPE_PATH[shape] ?? SHAPE_PATH.sine} fill="none" stroke="var(--gold)" strokeWidth="1.3" /></svg>
);

export function LfoPane() {
  const lfos = useProject((d) => d.modulators.lfos);
  const values = useProject((d) => d.modulators.values);
  const bpm = useProject((d) => d.settings.bpm);
  return (
    <div className="lfopane">
      <div className="lfonote">
        <b>Project-level</b> modulators, not per-block. Their clock is the timeline itself, so switching blocks never resets a phase. Periods are in <b>musical time</b> at <b>{bpm} BPM</b>.
      </div>
      {/* Compact tiles, several per row (plan §6.3): a readout header; click to open the controls. */}
      <div className="lfotiles">
        {lfos.map((l) => <LfoRow key={l.id} id={l.id} />)}
        <button className="lfoadd" onClick={addLfo} title="Add a project LFO">＋ New LFO</button>
        {/* Phase 1.5: Values share the LFOs' row of tiles, so the pane keeps its height. */}
        {(values ?? []).map((v) => <ValueRow key={v.id} id={v.id} />)}
        <button className="lfoadd" onClick={() => addValue()} title="Add a project Value: one named knob that drives any number of params, each through its own range and curve. Linking replaces a param's dialled value; an LFO on it still swings around the Value.">＋ New Value</button>
      </div>
    </div>
  );
}

// ---------- Values (Phase 1.5) ----------

/**
 * Named project knobs (Phase 1.5): one Value drives any number of params (GLITCH INTENSITY on three
 * effects), each through its own Map-Range (from → to, in the param's units) and curve. A tile like
 * an LFO's, opened to edit; on the canvas, ghosts wired to the params they drive.
 */
function ValueRow({ id }: { id: string }) {
  const v = useProject((d) => d.modulators.values?.find((x) => x.id === id));
  const doc = useProject((d) => d);
  const { block } = useActive();
  const links = useMemo(() => valueLinks(doc).filter((k) => k.valueId === id), [doc, id]);
  const candidates = useMemo(
    () => (block ? chainOrder(block).flatMap((n) => (nodeDefsOf(n.kind)?.params ?? []).filter((p) => p.modulatable && !n.bindings[p.key]?.value).map((p) => ({ n, p }))) : []),
    [block],
  );
  const [open, setOpen] = useSticky(`value.tile:${id}`, false);
  if (!v) return null;
  if (!open) {
    return (
      <button className="lfotile valuetile" onClick={() => setOpen(true)} aria-label={`Value ${v.label}`} title={`${v.label}: ${v.value.toFixed(2)}, drives ${links.length} param${links.length === 1 ? '' : 's'} — click to edit`}>
        <span className="lthd"><span className="vbadge" aria-hidden>◆</span><b>{v.label}</b></span>
        <span className="ltro"><i>VALUE</i><b>{v.value.toFixed(2)}</b></span>
        <span className="ltro"><i>LINKS</i><b className={links.length ? 'on' : ''}>{links.length}</b></span>
      </button>
    );
  }
  return (
    <div className="lforow open valuerow" aria-label={`Value ${v.label}`}>
      <div className="lh">
        <button className="ltclose" onClick={() => setOpen(false)} title="Fold back to a tile">▾</button>
        <span className="cbadge vbadge" aria-hidden>◆</span>
        <input className="vname" defaultValue={v.label} key={v.label} aria-label="Value name" spellCheck={false}
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== v.label && setValue(v.id, { label: e.target.value.trim() }, `Renamed a Value → ${e.target.value.trim()}`)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        <button className="ghostbtn vremove" onClick={() => removeValue(v.id)} title={links.length ? `Remove this Value (its ${links.length} link${links.length > 1 ? 's go' : ' goes'} too; undoable)` : 'Remove this Value'} aria-label="Remove Value">✕</button>
      </div>
      <div className="lfoparams">
        <ParamControl variant="full" fieldKey={`${v.id}|value`} spec={{ label: 'Value', type: 'float', min: 0, max: 1, default: 0.5, help: '0..1, mapped onto each linked param by its range and curve' }} value={v.value} onChange={(x) => setValue(v.id, { value: x as number }, `${v.label} → ${(x as number).toFixed(2)}`)} />
      </div>
      <div className="lflinks">
        <span className="minilabel">drives</span>
        {links.length === 0 && <span className="dim">no param yet: link one below</span>}
        {links.map((k) => {
          const pd = nodeDefsOf(k.node.kind)?.params.find((p) => p.key === k.key);
          const range = { type: 'float' as const, min: pd?.min ?? 0, max: pd?.max ?? 1, unit: pd?.unit, step: pd?.step };
          return (
            <div key={`${k.node.id}:${k.key}`} className="lchip2 vlink">
              <span className="lchiplbl" title={`Block ${k.blockIndex + 1} · ${nodeLabel(k.node)} · ${pd?.label ?? k.key}`}>Blk {k.blockIndex + 1} · {nodeLabel(k.node)} · {pd?.label ?? k.key}</span>
              <ParamControl variant="mini" fieldKey={`${k.node.id}|${k.key}|from`} spec={{ ...range, label: 'from', default: range.min, help: 'The param when the Value is 0' }} value={k.link.from} onChange={(x) => setValueLink(k.block.id, k.node.id, k.key, { from: x as number })} />
              <ParamControl variant="mini" fieldKey={`${k.node.id}|${k.key}|to`} spec={{ ...range, label: 'to', default: range.max, help: 'The param when the Value is 1' }} value={k.link.to} onChange={(x) => setValueLink(k.block.id, k.node.id, k.key, { to: x as number })} />
              <select className="vcurve" value={k.link.curve} aria-label="Curve" title="How the Value travels from 'from' to 'to'" onChange={(e) => setValueLink(k.block.id, k.node.id, k.key, { curve: e.target.value as never })}>
                {VALUE_CURVES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="vnow" title="What the param is now">= {+mapValue(v.value, k.link).toFixed(3)}{pd?.unit ?? ''}</span>
              <button title="Unlink" aria-label="Unlink" onClick={() => unlinkValue(k.block.id, k.node.id, k.key)}>✕</button>
            </div>
          );
        })}
        <select
          className="linksel"
          value=""
          aria-label={`Link a param to ${v.label}`}
          title={block ? 'Drive a parameter in the current block with this Value' : 'Select a block on the arrangement first'}
          disabled={!block || !candidates.length}
          onChange={(e) => {
            const c = candidates[+e.target.value];
            if (c && block) linkValue(v.id as never, block.id, c.n.id, c.p.key);
          }}
        >
          <option value="">⊸ drive a param in this block…</option>
          {candidates.map((c, i) => <option key={i} value={i}>{nodeLabel(c.n)} · {c.p.label}</option>)}
        </select>
      </div>
    </div>
  );
}

function LfoRow({ id }: { id: string }) {
  const l = useProject((d) => d.modulators.lfos.find((x) => x.id === id))!;
  const doc = useProject((d) => d);
  const playhead = useUi((s) => s.playhead);
  const { block } = useActive();
  const links = useMemo(() => lfoLinks(doc).filter((k) => k.lfoId === l.id), [doc, l.id]);
  const periodSec = l.unit === 'beats' ? beatsToSec(l.period, doc.settings.bpm) : l.period;
  // Phase is a pure function of the timeline frame (L8): same value from any block's graph.
  const t = playhead / (doc.settings.fps.num / doc.settings.fps.den);
  const phase = (((t / periodSec + l.phase) % 1) + 1) % 1;
  const [open, setOpen] = useSticky(`lfo.tile:${l.id}`, false);
  const candidates = useMemo(
    () => (block ? chainOrder(block).flatMap((n) => (nodeDefsOf(n.kind)?.params ?? []).filter((p) => p.modulatable && !n.bindings[p.key]?.lfo).map((p) => ({ n, p }))) : []),
    [block],
  );
  if (!open) {
    return (
      <button className="lfotile" onClick={() => setOpen(true)} title={`${l.label}: ${l.shape}, one cycle every ${l.period} beats, ${links.length} linked — click to edit`}>
        <span className="lthd"><WaveIcon shape={l.shape} /><b>{l.label}</b></span>
        <span className="ltro"><i>PERIOD</i><b>{l.period % 4 === 0 ? `${l.period / 4} bar${l.period === 4 ? '' : 's'}` : `${l.period} beats`}</b></span>
        <span className="ltro"><i>LINKS</i><b className={links.length ? 'on' : ''}>{links.length}</b></span>
        <span className="ltphase" title={`Phase ${(phase * 360).toFixed(0)}°`}><span style={{ left: `${phase * 100}%` }} /></span>
      </button>
    );
  }
  return (
    <div className="lforow open">
      <div className="lh">
        <button className="ltclose" onClick={() => setOpen(false)} title="Fold back to a tile">▾</button>
        <span className="lname">{l.label}</span>
        <div className="lfophase" title={`Phase at the playhead: ${(phase * 360).toFixed(0)}° — continuous across every block`}>
          <span className="lfodot" style={{ left: phase * 100 + '%', animation: 'none' }} />
        </div>
        <RadialPick
          title="Waveform"
          className="wavepick"
          value={l.shape}
          options={LFO_SHAPES.map((s) => ({ label: s, value: s, color: 'var(--gold)' }))}
          onChange={(shape) => setLfo(l.id, { shape }, `${l.label} shape → ${shape}`)}
          label={<><WaveIcon shape={l.shape} /> {l.shape}</>}
        />
      </div>
      <div className="lfoparams">
        <ParamControl variant="full" fieldKey={`${l.id}|period`} spec={{ label: 'Period', type: 'beats', min: 0.25, max: 32, default: 8, help: 'One cycle, in musical time' }} value={l.period} onChange={(v) => setLfo(l.id, { period: v as number, unit: 'beats' }, `${l.label} period`)} />
        <ParamControl variant="full" fieldKey={`${l.id}|phase`} spec={{ label: 'Phase', type: 'float', min: 0, max: 360, unit: '°', step: 1, default: 0, help: 'Offset at timeline frame 0' }} value={Math.round(l.phase * 360)} onChange={(v) => setLfo(l.id, { phase: (v as number) / 360 }, `${l.label} phase`)} />
      </div>
      <div className="lflinks">
        <span className="minilabel">linked</span>
        {links.length === 0 && <span className="dim">none</span>}
        {links.map((k) => {
          const pdef = nodeDefsOf(k.node.kind)?.params.find((p) => p.key === k.key);
          return (
            <div key={`${k.node.id}:${k.key}`} className="lchip2">
              <span className="lchiplbl" title={`Block ${k.blockIndex + 1} · ${nodeLabel(k.node)} · ${pdef?.label ?? k.key}`}>Blk {k.blockIndex + 1} · {nodeLabel(k.node)} · {pdef?.label ?? k.key}</span>
              <ParamControl variant="mini" fieldKey={`${k.node.id}|${k.key}|depth`} spec={{ label: 'depth', type: 'float', min: 0, max: 1, default: 0.5, help: 'How far the LFO swings the param' }} value={k.depth} onChange={(v) => setLinkDepth(k.block.id, k.node.id, k.key, v as number)} />
              <button title="Unlink" onClick={() => unlinkParam(k.block.id, k.node.id, k.key)}>✕</button>
            </div>
          );
        })}
        <select
          className="linksel"
          value=""
          title="Link a parameter in the current block to this LFO"
          onChange={(e) => {
            const c = candidates[+e.target.value];
            if (c && block) linkParam(l.id, block.id, c.n.id, c.p.key);
          }}
        >
          <option value="">⊸ link a param in this block…</option>
          {candidates.map((c, i) => <option key={i} value={i}>{nodeLabel(c.n)} · {c.p.label}</option>)}
        </select>
      </div>
    </div>
  );
}

// ---------- mini timeline ----------

export function MiniTimeline() {
  const blocks = useProject((d) => d.timeline.blocks);
  const fps = useProject((d) => d.settings.fps);
  const bpm = useProject((d) => d.settings.bpm);
  const playhead = useUi((s) => s.playhead);
  const { block, blockIndex } = useActive();
  const total = blocks.reduce((a, b) => a + blockFrames(b), 0) || 1;
  const starts = blockStarts(blocks);
  return (
    <div className="minitl">
      <div className="track" style={{ position: 'relative' }}>
        {blocks.map((b, i) => (
          <button
            key={b.id}
            className={'mb ' + (b.kind === 'picture' ? 'pic' : 'mot') + (b.id === block?.id ? ' cur' : '')}
            style={{ flex: `${blockFrames(b)} 1 0` }}
            title={`Block ${i + 1} · ${b.kind} ×${b.repeat} — click to edit its graph`}
            onClick={() => (selectBlock(b.id), setUi({ playhead: starts[i] }))}
          />
        ))}
        <span className="mph" style={{ left: (playhead / total) * 100 + '%' }} />
      </div>
      <div className="cap">
        <span>playhead {barsBeats(playhead, fps, bpm)} · {timecode(playhead, fps)} · block {blockIndex + 1}</span>
        <span>Alt+2 to arrange</span>
      </div>
    </div>
  );
}
