// Shared node projections: the param bound to a node instance, the Inspector, the per-node
// viewer. Mosh mode and the Node workspace render the same components (one visual grammar).
import { useMemo, useRef } from 'react';
import type { Block, NodeDef, NodeInstance, ParamDef, ParamValue } from '@moshpit/engine';
import { CONTAINER_KIND, macroValue } from '@moshpit/engine';
import { defOf } from '../engine';
import { CATS, FAMILY_COLOUR } from '../lib/cats';
import { MAX_MACROS, activeBlock, exposeMacro, projectLooks, removeLook, saveLook, unpackNodes, updateFromMaster, updateMaster, getDoc, isFrozen, nodesOf, paramsOf, removeMacro, renameContainer, scopeOfNode, trialGraph, setBypass, setParam, setParams, toggleFreeze, toggleViewer, useProject } from '../state/project';
import { blockStarts, blockFrames } from '../lib/timeline';
import { ParamControl } from '../params/Param';
import { FrameView } from './FrameView';
import { EffectPresets } from './EffectPresets';
import { envelopeParams, focusAnimation } from '../state/animation';
import { readEnvelope } from '../lib/parameterEnvelope';
import { AuditionBar } from './AuditionBar';
import { auditionGraph } from '../state/audition';
import { Banner, Empty, confirmAction, toast, toastError } from '../qol/qol';
import { openContainer, setUi, useUi, useSettings } from '../state/ui';

/** The active block and its per-block view state, as stable references. */
export function useActive() {
  const block = useProject(activeBlock);
  const view = useProject((d) => (block ? d.view.perBlock[block.id] : undefined));
  const blockIndex = useProject((d) => (block ? d.timeline.blocks.indexOf(block) : -1));
  // 3.2: a node inside an open container is selected and viewed like any other.
  const selected = block && nodesOf(block).find((n) => n.id === view?.selected[0]);
  const viewer = block && nodesOf(block).find((n) => n.id === view?.viewer);
  return { block, blockIndex, view, selected, viewer };
}

export const nodeLabel = (n: NodeInstance) => n.label ?? defOf(n.kind)?.label ?? n.kind;
export const catOf = (n: NodeInstance) => CATS[defOf(n.kind)?.category ?? 'Effect'];
export const blockName = (b: Block, i: number) => `Block ${i + 1} · ${b.kind === 'picture' ? 'picture' : `motion ×${b.repeat}`}`;

/** Node params in graph order (sources → output), for the strip and the LFO link list. */
export function chainOrder(block: Block): NodeInstance[] {
  const out: NodeInstance[] = [];
  const seen = new Set<string>();
  const visit = (n: NodeInstance) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    block.graph.edges.filter((e) => e.to.node === n.id).forEach((e) => {
      const up = block.graph.nodes.find((x) => x.id === e.from.node);
      if (up) visit(up);
    });
    out.push(n);
  };
  [...block.graph.nodes].sort((a, b) => a.position.x - b.position.x).forEach(visit);
  return out;
}

/** The value source label for a param bound to an LFO, e.g. "LFO 1". */
function useModLabel(n: NodeInstance, key: string) {
  const lfoId = n.bindings[key]?.lfo?.lfoId;
  return useProject((d) => (lfoId ? d.modulators.lfos.find((l) => l.id === lfoId)?.label : undefined));
}

export function NodeParam({ block, node, p, variant }: { block: Block; node: NodeInstance; p: ParamDef; variant: 'mini' | 'full' }) {
  const mod = useModLabel(node, p.key);
  const legacy = (defOf(node.kind)?.defVersion ?? node.defVersion) > node.defVersion;
  const control = (
    <ParamControl
      spec={p}
      value={node.kind === CONTAINER_KIND ? macroValue(node, p.key) : node.params[p.key] ?? p.default}
      fieldKey={`${node.id}|${p.key}`}
      variant={variant}
      mod={readEnvelope(node.bindings[p.key]) ? 'Curve · base' : node.bindings[p.key]?.expression ? 'Formula · base' : mod}
      disabled={legacy}
      onChange={(v) => {
        try {
          setParam(block.id, node.id, p.key, v);
        } catch (e) {
          toastError(e);
        }
      }}
    />
  );
  return variant === 'full' && envelopeParams(node).some(param => param.key === p.key)
    ? <div className="node-param-animation">{control}<button className="parameter-animation-button" aria-label={`Animate ${p.label}`} title={`Animate ${p.label} in the timeline`} onClick={() => focusAnimation(block.id, node.id, p.key)}>◇</button></div>
    : control;
}

export function frameRangeOf(blocks: Block[], b: Block): [number, number] {
  const start = blockStarts(blocks)[blocks.indexOf(b)];
  return [start, start + blockFrames(b) - 1];
}

/** The engine freezes whole blocks today; node-level freeze is reported as not built (INTERNAL). */
export const NODE_FREEZE = false;
export const NODE_FREEZE_PLANNED = 'Node-level freeze is not in the engine yet — freeze the whole block instead (❄ on the arrangement)';

export async function freezeNode(block: Block, node: NodeInstance) {
  try {
    const now = await toggleFreeze({ kind: 'node', blockId: block.id, nodeId: node.id }, frameRangeOf(getDoc().timeline.blocks, block));
    toast(now ? `Froze ${nodeLabel(node)} → cached render` : `Unfroze ${nodeLabel(node)}`, { kind: 'ok' });
  } catch (e) {
    toastError(e);
  }
}


/** Inspector: the selected node's params (full controls), or the block when no node is selected. */
export function Inspector({ onOpenGraph }: { onOpenGraph?: () => void } = {}) {
  const { block, blockIndex, selected } = useActive();
  const frozen = useProject((d) => !!(block && selected && isFrozen(d, { kind: 'node', blockId: block.id, nodeId: selected.id })));
  if (!block) return <Empty icon="◆" title="No block selected">Click a block on the arrangement, or add one from slot A or B (⤓ block).</Empty>;
  if (!selected) {
    return (
      <Empty icon="◆" title="No node selected">
        Click a node in the strip or on the canvas to see its parameters. Editing <b>{blockName(block, blockIndex)}</b>.
      </Empty>
    );
  }
  const def = defOf(selected.kind);
  const C = catOf(selected);
  const legacy = def && def.defVersion > selected.defVersion;
  const box = selected.kind === CONTAINER_KIND;
  const params = paramsOf(selected);
  // 3.3: a node inside a container can put its numbers on the container's face as macros.
  const at = scopeOfNode(getDoc(), block.id, selected.id);
  const owner = typeof at === 'string' ? undefined : block.graph.nodes.find((n) => n.id === at.container);
  return (
    <div className="inspector-body">
      <div className="ih" tabIndex={0} data-help-label={nodeLabel(selected)} title={[def?.blurb, def?.category === 'Mosh' ? 'Works on the encoded video stream (the raw bitstream), not a decoded image.' : '', 'Drag a value to edit. Shift gives fine control; double-click resets; arrow keys step.'].filter(Boolean).join('\n\n')}>
        <span className="ic" style={{ background: `color-mix(in srgb, ${C.accent} 20%, transparent)`, color: C.accent }}>{C.icon}</span>
        <div>
          <b>{nodeLabel(selected)}</b>
          <div className="grp">
            {box ? `Container · ${(selected.body?.graph.nodes.length ?? 2) - 2} nodes` : def?.category ?? 'Unknown'}
            {def?.family && <> · <span style={{ color: FAMILY_COLOUR[def.family] }}>{def.family.toLowerCase()}</span></>}
            {def?.impl.preview === 'PROXY' && <> · <span className="approx">≈ preview</span></>}
          </div>
        </div>
        <span className="spacer" />
        <span className="scopetag block">block {blockIndex + 1}</span>
      </div>
      <div className="ibody">
        {!def ? (
          <Banner kind="warn"><b>Unknown node.</b> It comes from a newer Moshpit; it passes its input through and its settings are kept.</Banner>
        ) : (
          <>
            {legacy && <Banner kind="warn"><b>Legacy node.</b> It runs, but its settings are locked until you migrate it.</Banner>}
            {box && <ContainerName block={block} node={selected} />}
            {params.map((p) => (
              <div key={p.key} className={box ? 'macrorow' : undefined}>
                <NodeParam block={block} node={selected} p={p} variant="full" />
                {box && <button className="linkbtn macrox" onClick={() => removeMacro(block.id, selected.id, p.key)} title="Remove this macro; the param it drives keeps its value" aria-label={`Remove the ${p.label} macro`}>✕ remove macro</button>}
              </div>
            ))}
            {params.length === 0 && <div className="phelp">{box ? 'No macros yet. Open the container, select a node inside it, and expose a param as a macro.' : 'No parameters.'}</div>}
            {owner && <ExposeRow block={block} owner={owner} node={selected} />}
            {!box && <PresetRow block={block} node={selected} def={def} />}
            <div className="insp-actions">
              {def.freezable && (
                <button className={'ghostbtn' + (frozen ? ' act' : '')} disabled={!NODE_FREEZE} onClick={() => freezeNode(block, selected)} title={NODE_FREEZE ? "Bounce this node's output to a cached render so heavy chains stay responsive (L25)" : NODE_FREEZE_PLANNED}>
                  ❄ {frozen ? 'Unfreeze' : 'Freeze / re-render'}
                </button>
              )}
              {box && <button className="ghostbtn" onClick={() => { openContainer(block.id, selected.id); onOpenGraph?.(); }} title="Open it on the graph canvas (or double-click it there)">▸ Open</button>}
              {box && <LookButtons block={block} node={selected} />}
              {box && <button className="ghostbtn" onClick={() => { try { unpackNodes(block.id, selected.id); toast(`Unpacked ${nodeLabel(selected)}: its nodes are back in the block`, { kind: 'ok' }); } catch (e) { toastError(e); } }} title="Put its nodes back into the block's graph (Ctrl+Shift+G)">Unpack</button>}
              <button className={'ghostbtn' + (selected.bypass ? ' act' : '')} onClick={() => setBypass(block.id, selected.id, !selected.bypass)} title={box ? 'Skip the whole look (A/B it in place); its knobs and insides are kept' : 'Pass the input straight through'}>
                ⊘ {selected.bypass ? 'Bypassed' : 'Bypass'}
              </button>
              <button className="ghostbtn" onClick={() => toggleViewer(block.id, selected.id)} title="Show this node's output in the Node viewer">◉ View</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 3.6 / D1: a container and the library. Propagation is explicit: nothing changes behind your back. */
function LookButtons({ block, node }: { block: Block; node: NodeInstance }) {
  const master = useProject((d) => projectLooks(d).find((l) => l.id === node.body?.origin?.component));
  const run = (f: () => void, done: string) => { try { f(); toast(done, { kind: 'ok' }); } catch (e) { toastError(e); } };
  const newer = !!master && master.rev > (node.body?.origin?.rev ?? 0);
  return (
    <>
      <button className="ghostbtn" onClick={() => run(() => saveLook(block.id, node.id), `Saved ${nodeLabel(node)} to this project's looks: find it under Looks in the effect browser`)} title="Keep this container as a look of your own: place copies of it from the effect browser">☆ Save as look</button>
      {master && <button className="ghostbtn" onClick={() => void confirmAction(`Remove the ${master.name} look from your library?`, 'This copy stays, unlinked; other placed copies stay too.', 'Remove look').then((ok) => ok && run(() => removeLook(master.id), `${master.name} is no longer in your library`))} title="Take the look this copy came from out of your library">✕ Remove from library</button>}
      {master && <button className="ghostbtn" onClick={() => run(() => updateMaster(block.id, node.id), `${master.name} look updated from this copy`)} title={`Make this copy the ${master.name} look's next version (other copies keep theirs until you update them)`}>⇪ Update master</button>}
      {master && <button className={'ghostbtn' + (newer ? ' act' : '')} onClick={() => run(() => updateFromMaster(block.id, node.id), `This copy now matches the ${master.name} look`)} title={newer ? `The ${master.name} look has a newer version: take it (turned knobs keep their values)` : `Reset this copy's insides to the ${master.name} look`}>⇩ Update from master{newer ? ' ●' : ''}</button>}
    </>
  );
}

/** A container's name, edited in place (one undo step per rename). */
function ContainerName({ block, node }: { block: Block; node: NodeInstance }) {
  return (
    <label className="ctrname">
      <span className="minilabel">Name</span>
      <input defaultValue={nodeLabel(node)} key={node.id + nodeLabel(node)} aria-label="Container name" maxLength={80}
        onBlur={(e) => e.target.value.trim() !== nodeLabel(node) && renameContainer(block.id, node.id, e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}

/** 3.3: put one of this inner node's numbers on its container's face (and a CT dial). */
function ExposeRow({ block, owner, node }: { block: Block; owner: NodeInstance; node: NodeInstance }) {
  const macros = owner.body?.macros ?? [];
  const free = (defOf(node.kind)?.params ?? []).filter((p) => (p.type === 'float' || p.type === 'int') && p.min !== undefined && p.max !== undefined && !macros.some((m) => m.target.node === node.id && m.target.param === p.key));
  if (!free.length) return null;
  const full = macros.length >= MAX_MACROS;
  return (
    <div className="exposerow">
      <div className="minilabel">Macros on {nodeLabel(owner)} · {macros.length}/{MAX_MACROS}</div>
      <select aria-label="Expose a param as a macro" disabled={full} value="" title={full ? `${nodeLabel(owner)} already has ${MAX_MACROS} macros (the CT's dials)` : 'Put this number on the container: a knob on its face and a CT dial'}
        onChange={(e) => { try { if (e.target.value) exposeMacro(block.id, owner.id, node.id, e.target.value); } catch (err) { toastError(err); } }}>
        <option value="">{full ? 'Six macros already' : '◇ Expose as a macro…'}</option>
        {free.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
    </div>
  );
}

/** Per-op presets: Moshpit 1's tuned set from the engine (157 over 31 kinds), plus a dice. */
function PresetRow({ block, node, def }: { block: Block; node: NodeInstance; def: NodeDef }) {
  const numeric = useMemo(() => def.params.filter((p) => p.type === 'float' || p.type === 'int'), [def]);
  const locked = useProject(d => isFrozen(d, { kind: 'block', blockId: block.id }) || isFrozen(d, { kind: 'node', blockId: block.id, nodeId: node.id }));
  if (!def.params.length) return null;
  const apply = (name: string, values: Record<string, ParamValue>) => {
    try {
      setParams(block.id, node.id, values, `${nodeLabel(node)} preset → ${name}`);
    } catch (e) {
      toastError(e);
    }
  };
  // Dice: uniform within each numeric param's range. A UI edit, not render randomness (L11 unaffected).
  const dice = () =>
    apply('dice', Object.fromEntries(numeric.map((p) => {
      const lo = p.min ?? 0;
      const hi = p.max ?? 1;
      const v = lo + Math.random() * (hi - lo);
      return [p.key, p.type === 'int' ? Math.round(v) : +v.toFixed(3)];
    })));
  return <EffectPresets key={node.id} def={def} values={node.params} onApply={apply} disabled={locked || def.defVersion > node.defVersion}
    extra={numeric.length > 0 && <button className="preset dice" disabled={locked || def.defVersion > node.defVersion} onClick={dice} title="Randomise within each param's range">⚄ dice</button>} />;
}

/** TD-style viewer: the picture at the flagged node (or, with none flagged, the selected one), not the final render. */
export function NodeViewer() {
  const { block, viewer: flagged, selected } = useActive();
  const viewer = flagged ?? selected;
  // P1-C (audit): the node view holds its frame while playing, so playback renders the output only.
  const held = useRef(0);
  const playing = useUi((s) => s.playing);
  const playhead = useUi((s) => (s.playing ? held.current : (held.current = s.playhead)));
  const start = useProject((d) => (block ? blockStarts(d.timeline.blocks)[d.timeline.blocks.indexOf(block)] : 0));
  if (!block || !viewer) {
    return (
      <Empty icon="◉" title="No node selected">
        Click a node in the graph to see the picture at that point in its chain. ◉ on a node pins it here.
      </Empty>
    );
  }
  const C = catOf(viewer);
  // A TIMELINE frame inside this block (the engine's contract): the playhead, held to the block.
  const frame = Math.max(start, Math.min(start + blockFrames(block) - 1, playhead));
  // V4 (UX round 2): one Context surface, labelled with exactly what it shows.
  const at = chainOrder(block).findIndex((n) => n.id === viewer.id) + 1;
  return (
    <div className="pvcard">
      <div className="ctxlbl"><i>CONTEXT</i><b>NODE {String(at).padStart(2, '0')} · {nodeLabel(viewer).toUpperCase()}</b><em>OUTPUT{flagged ? ' · PINNED' : ''}</em></div>
      <FrameView target={{ kind: 'node', blockId: block.id, nodeId: viewer.id, frame }} maxW={480} label={nodeLabel(viewer)} />
      <div className="viewnote">
        Output <b style={{ color: C.accent }}>at {nodeLabel(viewer)}</b>{flagged ? ' (pinned ◉)' : ' (selected)'}, not the final render{playing ? ' · held while playing' : ''}
        {flagged && <> · <button className="linkbtn" onClick={() => toggleViewer(block.id, viewer.id)}>unpin</button></>}
      </div>
    </div>
  );
}

/** Phase 2.6: two pictures, the over one clipped to the right of `at`; drag the line to move it. */
function Wipe({ at, under, over }: { at: number; under: React.ReactNode; over: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const set = (x: number) => { const r = el.getBoundingClientRect(); setUi({ wipe: Math.max(0, Math.min(1, (x - r.left) / r.width)) }); };
    set(e.clientX);
    (e.target as Element).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => set(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="wipe" ref={ref} style={{ ['--wipe' as string]: `${at * 100}%` }}>
      <div className="wunder">{under}</div>
      <div className="wover">{over}</div>
      <div className="wline" role="slider" aria-label="Wipe: original left, audition right" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(at * 100)} onPointerDown={drag}><span>ORIGINAL ◂ ▸ AUDITION</span></div>
    </div>
  );
}

/** Final timeline output at the playhead; during an audition (Phase 2.2) the output with it, not applied. */
export function OutputPreview({ viewport, maxW = 1280, reportState = true, allowAudition = true }: { allowAudition?: boolean; viewport?: (picture: React.ReactNode) => React.ReactNode; maxW?: number; reportState?: boolean } = {}) {
  const quality = useSettings(s => s.previewResolution);
  const playhead = useUi((s) => s.playhead);
  const audition = useUi((s) => s.audition);
  const a = allowAudition ? audition : undefined;
  const block = useProject((d) => (a ? d.timeline.blocks.find((b) => b.id === a.blockId) : undefined));
  const graph = a ? auditionGraph(a) : null;
  // Phase 2.6: before / after. Held, the original shows instead; a wipe shows both, split.
  const reveal = useUi((s) => s.reveal);
  const wipe = useUi((s) => s.wipe);
  const showingTrial = !!(a && block && graph && !reveal);
  const report = reportState ? (outState: 'EXACT' | 'PROXY' | undefined) => setUi({ outState }) : undefined;
  const wrap = viewport ?? ((picture: React.ReactNode) => picture);
  const original = <FrameView progressive target={{ kind: 'output', frame: playhead }} maxW={maxW} quality={quality} onState={showingTrial ? undefined : report} label={a && graph ? 'ORIGINAL · as the project is' : 'PROGRAM · final output'} />;
  if (!a || !block || !graph) return <div className="pvcard">{wrap(original)}</div>;
  const trial = <FrameView progressive target={{ kind: 'trial', blockId: block.id, graph, frame: playhead }} maxW={maxW} quality={quality} onState={report} label={`AUDITION · ${a.label} · not applied`} />;
  return (
    <div className={'pvcard auditioning' + (reveal ? ' revealing' : '')}>
      {wrap(wipe !== undefined && !reveal ? <Wipe at={wipe} under={original} over={trial} /> : reveal ? original : trial)}
      <AuditionBar a={a} />
    </div>
  );
}
