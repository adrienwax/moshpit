import { conformFrames } from '../../lib/frames';
import { slotPlayback, setSlotPlayback, pauseSlotPlayback, useSlotPlayback, shuttleSlot } from '../../state/slotPlayback';
// MOSH desk: one docked viewer/transport, source range controls and a working edit timeline.
// Selected block/effect properties use the existing inspector; recipes remain a secondary disclosure.
import { useEffect, useRef } from 'react';
import type { Block } from '@moshpit/engine';
import { FrameView } from '../../components/FrameView';
import { PreviewTransport } from '../../components/PreviewTransport';
import { ViewerViewport } from '../../components/ViewerViewport';
import { useSticky } from '../../state/store';
import { Inspector, NodeParam, OutputPreview, frameRangeOf, useActive } from '../../components/nodes';
import { NumberField, ParamControl } from '../../params/Param';
import { Empty, confirmAction, toast, toastError } from '../../qol/qol';
import { setSettings as setProjectSettings, appendEffect, duplicateBlock, getDoc, isFrozen, removeBlock, removeNodes, setBlock, setMarks, sourceById, toggleFreeze, trimBlock, undoAction, useProject } from '../../state/project';
import { setLoupe, setSettings, setUi, setWs, uiStore, useSettings, useUi } from '../../state/ui';
import { setWsLayout, type WsLayout } from '../../layout/model';
import { fmtFps, fpsValue, timecode } from '../../lib/time';
import { blockFrames, blockStarts, timelineFrames } from '../../lib/timeline';
import { RecentPreviews } from '../../shell/QuickRender';
import { applyPreset } from '../render/RenderPanes';
import { PRESETS, exportPresetMatches, formatLabel, queueRender } from '../../state/render';
import { ClipTimeline, HistoryPane, RecipesPane, useLoupeClip } from './MoshPanes';
import { Icon } from '../../components/Icon';
import { MediaMark, Timecode } from '../../components/MediaReadout';
import { RadialPick } from '../../radial/RadialPick';
import { defOf } from '../../engine';
import { AppliedChain, BlockContext, ViewingContext } from './TaskDesk';
import { openDeskDetail } from '../../state/desk';
import { blocksShortcutTarget } from '../../lib/keyboard';

// ---------- A/B slots ----------

/** Both slots, stacked. The slot you touch is the slice target: I/O, J/K/L and , . act on it. */
export function SlotsPane() {
  return (
    <div className="slots">
      <Slot which="A" />
      <Slot which="B" />
    </div>
  );
}

function Slot({ which }: { which: 'A' | 'B' }) {
  const { src, frame } = useLoupeClip(which);
  const target = useUi((s) => s.sliceTarget) === which;
  if (!src) {
    return (
      <div className="loupe slot empty" data-loupe={which}>
        <Empty icon="▤" title={`Slot ${which} is empty`}>Send a selection here from IN (Alt+1), or click a clip on the left (Shift-click: slot B).</Empty>
      </div>
    );
  }
  return (
    <div className={'loupe slot' + (target ? ' target' : '')} data-loupe={which} onPointerDownCapture={() => !target && setUi({ sliceTarget: which })}>
      <div className="lbl">
        <span className={'tag ' + (which === 'A' ? 'in' : 'out')}>{which}</span>
        <b title={src.name}>{src.name}</b>
        {target && <span className="tag slicing" title="I / O, J / K / L and , . work on this slot">SLICING</span>}
      </div>
      <FrameView target={{ kind: 'source', sourceId: src.id, frame }} maxW={560} className="slotframe" />
      <ClipTimeline which={which} />
    </div>
  );
}


/**
 * The slice keys, now that the standalone slice timeline is folded into the slots: J/K/L shuttle
 * (again = faster, K stops), , . step one frame, I / O mark — all on the target slot.
 */
export function useSlotKeys() {
  const projectId = useProject(d => d.id);
  const pos = useRef<number | null>(null);
  useEffect(() => {
    pauseSlotPlayback();
    let raf = 0, last = performance.now();
    const loupeNow = (which?: 'A' | 'B') => {
      const ui = uiStore.get(), d = getDoc();
      const w = which ?? ui.sliceTarget;
      const src = d.resources.sources.find((s) => s.id === ui.loupes[w].src) ?? d.resources.sources[w === 'A' ? 0 : Math.min(1, d.resources.sources.length - 1)];
      const conf = src && d.resources.conforms.find((c) => c.sourceId === src.id);
      return { w, src, frames: src ? conformFrames(src, conf, d.settings.fps) : 1, frame: Math.round(ui.loupes[w].frame), fps: fpsValue(d.settings.fps) };
    };
    const tick = () => {
      const t = performance.now(), dt = Math.max(0, (t - last) / 1000);
      last = t;
      const playback = slotPlayback.get();
      if (playback.rate) {
        const l = loupeNow(playback.which);
        if (pos.current !== null && Math.round(pos.current) !== l.frame) pos.current = l.frame;
        if (l.src) {
          pos.current = Math.max(0, Math.min(l.frames - 1, (pos.current ?? l.frame) + playback.rate * l.fps * dt));
          setLoupe(l.w, { src: l.src.id, frame: pos.current });
          if (pos.current <= 0 || pos.current >= l.frames - 1) pauseSlotPlayback();
        } else pauseSlotPlayback();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || blocksShortcutTarget(e.target) || document.querySelector('[role=alertdialog]')) return;
      const k = e.key.toLowerCase();
      if (!['j', 'k', 'l', ',', '.', 'i', 'o'].includes(k)) return;
      const l = loupeNow();
      if (!l.src) return;
      e.preventDefault();
      const m = l.src.marks[0];
      pos.current = null;
      if (k === 'j') shuttleSlot(l.w, -1);
      else if (k === 'l') shuttleSlot(l.w, 1);
      else if (k === 'k') pauseSlotPlayback();
      else if (k === ',') setLoupe(l.w, { src: l.src.id, frame: Math.max(0, l.frame - 1) });
      else if (k === '.') setLoupe(l.w, { src: l.src.id, frame: Math.min(l.frames - 1, l.frame + 1) });
      else if (k === 'i') setMarks(l.src.id, l.frame, Math.max(l.frame + 1, m?.out ?? l.frame + 1));
      // OUT is exclusive: O on a frame keeps that frame in the slice.
      else if (k === 'o') setMarks(l.src.id, Math.min(m?.in ?? 0, l.frame), Math.min(l.frames, l.frame + 1));
    };
    window.addEventListener('keydown', key);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', key); pauseSlotPlayback(); };
  }, [projectId]);
}

// ---------- Docked edit/source viewer and contextual controls ----------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The project tempo, editable where it is always visible (the arrangement footer hides on a cramped lane). */
// Phase 0.5: the same number control as every param (it was a third BPM behaviour, typed only).
const BPM_SPEC = { label: 'BPM', type: 'int', min: 60, max: 200, step: 1, default: 120 } as const;
function BpmField({ bpm }: { bpm: number }) {
  return (
    <NumberField className="bpmfield" spec={BPM_SPEC} value={bpm} ariaLabel="Project BPM" title="Project tempo (60–200): every beat value follows it"
      onChange={(v) => setProjectSettings({ bpm: v }, `BPM → ${v}`)} />
  );
}

function ComposeTop() {
  const resolution = useSettings(s => s.previewResolution);
  const out = useUi((s) => s.outState);
  const fps = useProject((d) => d.settings.fps);
  const bpm = useProject((d) => d.settings.bpm);
  return (
    <div className="program-options" role="group" aria-label="Edit preview options"><strong className="edit-options-label">Edit</strong>
        <label className="preview-tempo">Tempo <BpmField bpm={bpm} /> BPM</label>
        <span>{fmtFps(fps)} fps</span>
        <span className="preview-quality" title="Exact matches the export path. Approximate preview uses a fast stand-in for bitstream effects; capture a preview to check the rendered result."><Icon name={out === 'EXACT' ? 'exact' : 'proxy'} size={14} />{out === 'PROXY' ? 'Approx. preview' : out === 'EXACT' ? 'Exact preview' : 'No frame'}</span>
        <div className="seg preview-resolution" role="group" aria-label="Program preview resolution" title="Auto shows a fast draft while scrubbing or playing, then refines the paused frame. Full uses the project working-size master. Captures and exports always use masters.">
          {(['auto', 'full'] as const).map(value => <button key={value} className={resolution === value ? 'on' : ''} aria-pressed={resolution === value} onClick={() => setSettings(s => void (s.previewResolution = value))}>{value === 'auto' ? 'Auto' : 'Full'}</button>)}
        </div>
    </div>
  );
}

/** PROGRAM: the final output at the playhead — the one monitor that shows the result — with its own transport. */
type ViewerTarget = 'program' | 'A' | 'B';
export function ProgramPane({ exportView = false }: { exportView?: boolean } = {}) {
  const [dual, setDual] = useSticky('program.dual', false);
  const [left, setLeft] = useSticky<ViewerTarget>('program.left', 'program');
  const [right, setRight] = useSticky<ViewerTarget>('program.right', 'A');
  const [side, setSide] = useSticky<'left' | 'right'>('program.activeSide', 'left');
  const split = dual && !exportView;
  const activeSide = split ? side : 'left';
  const target = exportView ? 'program' : activeSide === 'left' ? left : right;
  const a = useLoupeClip('A'), b = useLoupeClip('B');
  const playback = useSlotPlayback();
  const bpm = useProject(d => d.settings.bpm);
  const slot = target === 'B' ? b : a;
  const activate = (nextSide: 'left' | 'right', nextTarget: ViewerTarget) => {
    if (nextSide !== activeSide || nextTarget !== target) {
      setUi({ playing: false }); pauseSlotPlayback();
    }
    setSide(nextSide);
    if (nextTarget !== 'program') setUi({ sliceTarget: nextTarget });
  };
  const choose = (pane: 'left' | 'right', value: ViewerTarget) => {
    activate(pane, value); (pane === 'left' ? setLeft : setRight)(value);
    if (value !== 'program') openDeskDetail('source');
  };
  const monitor = (pane: 'left' | 'right', value: ViewerTarget) => <ProgramMonitor id={pane} target={value}
    active={pane === activeSide} onActivate={() => activate(pane, value)}
    setTarget={exportView ? undefined : value => choose(pane, value)}
    reportState={pane === activeSide && value === 'program'} allowAudition={!exportView && pane === activeSide} />;
  return <div className="program focused-program docked-program">
    {!exportView && <div className="viewer-mode" role="group" aria-label="Viewer layout" title="Source positions are independent">
      <button className="ghostbtn" aria-pressed={!dual} onClick={() => { if (activeSide === 'right') activate('left', left); setDual(false); }}>Single</button>
      <button className="ghostbtn" aria-pressed={dual} onClick={() => setDual(true)}>Split</button>
      <ComposeTop />
    </div>}
    {!exportView && <ViewingContext target={target} />}
    <div className={'program-monitors' + (split ? ' dual-monitor' : '')}>
      {monitor('left', exportView ? 'program' : left)}
      {split && monitor('right', right)}
    </div>
    {target === 'program' ? <ProgramTransport allowAudition={!exportView} /> : <PreviewTransport
      target={`Source ${target} · ${slot.src?.name ?? 'empty'}`} frame={slot.frame} frames={slot.src ? slot.frames : 0} fps={slot.fps} bpm={bpm}
      playing={playback.which === target && playback.rate !== 0}
      onSeek={frame => { pauseSlotPlayback(); slot.set(frame); }}
      onToggle={() => { if (slot.src) setSlotPlayback(target, playback.which === target && playback.rate ? 0 : 1); }}
      detail={`Conformed source · independent position · Space/CT transport controls Edit; J/K/L controls Source ${target}`} />}
  </div>;
}

function ProgramMonitor({ id, target, setTarget, reportState, active, onActivate, allowAudition = true }: {
  id: string; target: ViewerTarget; setTarget?: (target: ViewerTarget) => void;
  reportState: boolean; active: boolean; onActivate: () => void; allowAudition?: boolean;
}) {
  const working = useProject(d => d.settings.working);
  const quality = useSettings(s => s.previewResolution);
  const a = useLoupeClip('A'), b = useLoupeClip('B');
  const slot = target === 'B' ? b : a;
  const toolbar = <>{setTarget ? <>
    <button className="ghostbtn viewer-activate" aria-pressed={active} onClick={onActivate} aria-label={`Control ${id} viewer`}>{active ? 'Controls' : 'Control'}</button>
    <select aria-label={`${id} viewer source`} value={target} onChange={e => setTarget(e.target.value as ViewerTarget)}>
      <option value="program">Edit result</option><option value="A">Source A</option><option value="B">Source B</option>
    </select></> : <strong className="preview-source-title">Edit result</strong>}
    {target !== 'program' && <span className="dim">Independent · frame {slot.frame}</span>}
  </>;
  const viewport = (picture: React.ReactNode) => <ViewerViewport id={id} width={working.w} height={working.h} toolbar={toolbar}>{picture}</ViewerViewport>;
  return <div className={'program-monitor' + (active ? ' controlled' : '')} data-viewer={id}>
    {target === 'program' ? <OutputPreview allowAudition={allowAudition} viewport={viewport} maxW={working.w} reportState={reportState} /> : viewport(slot.src
      ? <FrameView target={{ kind: 'source', sourceId: slot.src.id, frame: slot.frame }} maxW={working.w} quality={quality} label={`SOURCE ${target} · ${slot.src.name}`} />
      : <div className="viewer-empty">Send a clip to Source {target} from IN.</div>)}
  </div>;
}

export function SourceDesk({ which }: { which: 'A' | 'B' }) {
  const { src } = useLoupeClip(which);
  const playback = useSlotPlayback();
  return <section className="source-desk" aria-label={`Source ${which} range controls`}>
    <div className="source-desk-tools"><strong>Source {which}</strong>
      <button className="tbtn" disabled={!src} onClick={() => shuttleSlot(which, -1)} title="Reverse shuttle (J); repeat to increase speed"><Icon name="shuttle-rev" size={14} />Reverse</button>
      <button className="tbtn" disabled={!src} onClick={() => shuttleSlot(which, 0)} title="Stop source shuttle (K)">Stop</button>
      <button className="tbtn" disabled={!src} onClick={() => shuttleSlot(which, 1)} title="Forward shuttle (L); repeat to increase speed"><Icon name="shuttle-fwd" size={14} />Forward</button>
      <span className="mono">{playback.which === which ? playback.rate : 0}×</span><SnapPick />
      <span className="dim">Out exclusive</span>
    </div>
    <ClipTimeline which={which} compact />
  </section>;
}

/**
 * The Program monitor's transport (Waxy: "the program monitor has no real transport"), matching
 * Source's player: to start, step back, play / pause, step forward, to end, a seek bar over the
 * whole edit (block edges marked) and the timecode with its frame. Steps and seeks stop playback.
 */
export function ProgramTransport({ allowAudition = true }: { allowAudition?: boolean } = {}) {
  const playing = useUi(s => s.playing);
  const playhead = useUi(s => s.playhead);
  const audition = useUi(s => s.audition);
  const fps = useProject(d => d.settings.fps);
  const name = useProject(d => d.name);
  const blocks = useProject(d => d.timeline.blocks);
  const total = timelineFrames(blocks);
  const bpm = useProject(d => d.settings.bpm);
  return <PreviewTransport target={allowAudition && audition ? 'Edit audition · ' + audition.label : 'Edit · ' + name}
    frame={playhead} frames={total} fps={fps} playing={playing}
    onSeek={frame => setUi({ playing: false, playhead: frame })}
    onToggle={() => setUi({ playing: !uiStore.get().playing })}
    bpm={bpm} boundaries={blockStarts(blocks)}
    detail="Space / CT: Edit" />;
}

// ---------- Block inspector (right), Effects (bottom-left), Render (bottom-right) ----------

export function BlockPane() {
  const { block, blockIndex } = useActive();
  return block ? <BlockTab block={block} index={blockIndex} /> : <Empty icon="▭" title="No block selected">Add a block from slot A or B (⤓ block), then click it on the arrangement.</Empty>;
}

/**
 * The block as a technical info sheet (DESIGN-SYSTEM.md §6.1): SOURCE IN/OUT is the file's own
 * time, CLIP IN/OUT the slice's; the frame range (inclusive) is kept apart from the count; a rate
 * the clip was conformed from is flagged amber, not hidden.
 */
function BlockTab({ block, index }: { block: Block; index: number }) {
  const src = useProject((d) => sourceById(d, block.sourceId));
  const fps = useProject((d) => d.settings.fps);
  const frozen = useProject((d) => isFrozen(d, { kind: 'block', blockId: block.id }));
  const n = block.out - block.in;
  const pf = fpsValue(fps);
  const sfps = src?.probe.fps;
  const startSec = src?.range?.startSec ?? 0;
  // A clip frame's time in the file: the slice's start, plus the frame at the project rate, read at the file's rate.
  const srcTc = (f: number) => (sfps ? timecode(Math.round((startSec + f / pf) * fpsValue(sfps)), sfps) : '—');
  const conformed = !!sfps && Math.abs(fpsValue(sfps) - pf) > 1e-3;
  const del = async () => {
    if (await confirmAction('Remove block?', <>Remove <b>Block {index + 1}</b> and its node graph from the arrangement? You can undo this.</>, 'Remove block')) {
      removeBlock(block.id);
      toast('Block removed', { action: undoAction() });
    }
  };
  return (
    <div className="blocktab">
      <section className="block-facts" aria-label="Block information">
        <header><span className="block-number">{pad2(index + 1)}</span><span><b>Block {index + 1}</b><small>{block.kind === 'picture' ? 'Picture' : 'Motion'}</small></span></header>
        <div className="block-source" title={src?.path}><Icon name="source" size={16} /><span>{src?.name ?? 'Missing source'}</span></div>
        <div className="range-pair" role="group" aria-label="Clip range" title={`Times within the clip, at ${fmtFps(fps)} fps. Out is the first frame not included.`}>
          <div><MediaMark kind="in" /><Timecode frame={block.in} fps={fps} /></div><span className="range-join" aria-hidden="true">—</span><div><MediaMark kind="out" /><Timecode frame={block.out} fps={fps} /></div>
        </div>
        <dl className="media-facts">
          <div><dt><MediaMark kind="duration" /></dt><dd>{(n / pf).toFixed(3)} <small>s</small></dd></div>
          <div><dt><MediaMark kind="frames" label="Count" /></dt><dd>{n} <small>frames</small></dd></div>
          <div><dt><MediaMark kind="range" label="Frame range" /></dt><dd>{block.in}<small>–</small>{block.out - 1}</dd></div>
          <div title={conformed ? 'Source rate converted to the project rate' : 'Source and project share a frame rate'}><dt><MediaMark kind="rate" /></dt><dd>{sfps && conformed ? <>{fmtFps(sfps)} <small>→</small> </> : null}{fmtFps(fps)} <small>fps</small></dd></div>
        </dl>
        <details className="source-time-details"><summary><Icon name="source" size={13} />Source timing{conformed ? ' · rate converted' : ''}</summary><div className="range-pair"><div><MediaMark kind="in" label="Source in" /><Timecode value={srcTc(block.in)} /></div><div><MediaMark kind="out" label="Source out" /><Timecode value={srcTc(block.out)} /></div></div><p>The file's original timecode. Out is exclusive.</p></details>
      </section>
      <div className="bgroups">
        <div className="bgroup" role="group" aria-label="Block actions">
          <span className="glbl">BLOCK</span>
          <button className="ghostbtn" onClick={() => (duplicateBlock(block.id), toast(`Duplicated Block ${index + 1}`, { action: undoAction() }))} title="A copy of this block after it, same range and graph"><Icon name="duplicate" size={14} />Duplicate</button>
          <button className={'ghostbtn' + (frozen ? ' act' : '')} aria-pressed={frozen} onClick={() => void toggleFreeze({ kind: 'block', blockId: block.id }, frameRangeOf(getDoc().timeline.blocks, block)).catch(toastError)} title="Cache this block's render so playback stays smooth"><Icon name="freeze" size={14} />{frozen ? 'Frozen' : 'Freeze'}</button>
          <button className="ghostbtn danger" onClick={() => void del()} title="Remove this block from the arrangement (undoable)"><Icon name="delete" size={14} />Remove</button>
        </div>
        <div className="bgroup" role="group" aria-label="Audio">
          <span className="glbl">AUDIO</span>
          <button className={'ghostbtn' + (block.audio.mute ? ' act' : '')} aria-pressed={block.audio.mute} onClick={() => setBlock(block.id, { mute: !block.audio.mute }, block.audio.mute ? 'Unmuted clip audio' : 'Muted clip audio')} title="The clip's own audio in the export"><Icon name={block.audio.mute ? 'mute' : 'audio'} size={14} />{block.audio.mute ? 'Muted' : 'Clip audio'}</button>
        </div>
        <button className="ghostbtn" onClick={() => (setUi({ libClip: src?.path }), setWs('browse'))} title="Back to IN with this clip selected"><Icon name="source" size={14} />Open source</button>
      </div>
      <BlockTrim block={block} />
      <BlockPlayback block={block} />
      <dl className="isheet">
        <span className="sec">KIND · REPEAT</span>
        <dt>KIND</dt>
        <dd className="ctl">
          <span className="seg" role="radiogroup" aria-label="Block kind" title="Picture holds a real keyframe and cuts hard; motion is P-frames only and smears (the mosh)">
            {(['picture', 'motion'] as const).map((k) => (
              <button key={k} role="radio" aria-checked={block.kind === k} className={block.kind === k ? 'on' : ''} disabled={k === 'motion' && index === 0} title={k === 'motion' && index === 0 ? 'The first block must be picture: a motion block smears the frames before it, and nothing comes before the first' : undefined} onClick={() => setBlock(block.id, { kind: k }, `Block ${index + 1} → ${k}`)}>{k}</button>
            ))}
          </span>
        </dd>
        <dt>REPEAT</dt>
        <dd className="ctl"><ParamControl variant="mini" fieldKey={`${block.id}|repeat`} spec={{ label: 'Repeat', type: 'int', min: 1, max: 64, step: 1, default: 1, unit: '×', help: 'Replay the range this many times' }} value={block.repeat} onChange={(v) => setBlock(block.id, { repeat: v as number }, `Block ${index + 1} ×${v}`)} /></dd>
      </dl>
    </div>
  );
}

/** F1 (UX round 2): trim the block in place — IN / OUT inside its clip, dragged or stepped. */
function BlockTrim({ block }: { block: Block }) {
  const frames = useProject((d) => d.resources.conforms.find((c) => c.sourceId === block.sourceId)?.frames ?? block.out);
  const field = (key: 'in' | 'out', label: string, min: number, max: number, help: string) => (
    <ParamControl variant="mini" fieldKey={`${block.id}|trim-${key}`} spec={{ label, type: 'int', min, max, step: 1, default: key === 'in' ? 0 : frames, help }} value={block[key]} onChange={(v) => trimBlock(block.id, { [key]: v as number })} />
  );
  return (
    <dl className="isheet blocktrim" title="Trim this block in place. It can only narrow inside the clip it was sliced from; to reach further, re-slice the clip in IN.">
      <span className="sec">TRIM</span>
      <dt><MediaMark kind="in" /></dt><dd className="ctl">{field('in', 'IN', 0, block.out - 1, `First frame of the clip this block plays (0–${block.out - 1}).`)}</dd>
      <dt><MediaMark kind="out" /></dt><dd className="ctl">{field('out', 'OUT', block.in + 1, frames, `Frame after the last one played: OUT is exclusive (${block.in + 1}–${frames}).`)}</dd>
      <dt><MediaMark kind="frames" label="Kept" /></dt><dd className="m trim-kept"><b>{block.out - block.in}</b> <span>of {frames} frames</span></dd>
    </dl>
  );
}

/**
 * F1: the block's playback in one place. Speed and Reverse are the engine's bitstream ops
 * (mosh.speed / mosh.reverse, as in Moshpit 1, where speed was an op too): this adds, shows or
 * removes them, and the length readout is the engine's, ops included.
 */
function BlockPlayback({ block }: { block: Block }) {
  const speed = block.graph.nodes.find((n) => n.kind === 'mosh.speed');
  const reverse = block.graph.nodes.find((n) => n.kind === 'mosh.reverse');
  const rate = speed && defOf(speed.kind)?.params.find((p) => p.key === 'rate');
  return (
    <dl className="isheet blockplay">
      <span className="sec">PLAYBACK</span>
      <dt>SPEED</dt>
      <dd className="ctl">
        {speed ? (
          <>
            {rate && <NodeParam block={block} node={speed} p={rate} variant="mini" />}
            <button className="ghostbtn" onClick={() => removeNodes(block.id, [speed.id])} title="Remove the speed op: back to the source rate">✕ speed</button>
          </>
        ) : (
          <button className="ghostbtn" onClick={() => appendEffect(block.id, 'mosh.speed')} title="Add a speed op to this block (repeated frames re-apply their motion, so slowing down smears)">＋ Speed</button>
        )}
      </dd>
      <dt>DIRECTION</dt>
      <dd className="ctl"><button className={'ghostbtn' + (reverse ? ' act' : '')} aria-pressed={!!reverse} onClick={() => (reverse ? removeNodes(block.id, [reverse.id]) : appendEffect(block.id, 'mosh.reverse'))} title="Play the block backwards (the reverse op)">⇆ Reverse</button></dd>
      <dt>LENGTH</dt><dd className="m">on the arrangement: {blockFrames(block)} f{block.repeat > 1 ? ` (×${block.repeat})` : ''}</dd>
    </dl>
  );
}

/** EFFECTS (bottom-left): add an effect or a recipe; the selected node's parameters below. */
export function EffectsPane() {
  const { selected } = useActive();
  return (
    <div className="effecttab">
      <BlockContext />
      <AppliedChain />
      {selected ? <Inspector /> : <BlockPane />}
      <details className="starting-recipes"><summary>Starting recipes</summary><div className="effrecipes"><RecipesPane /></div></details>
    </div>
  );
}

/** RENDER (bottom-right): the next step in the workflow, sharing the app's teal action treatment. */
export function RenderPane() {
  const ec = useProject(d => d.exportConfig);
  const hasBlocks = useProject(d => d.timeline.blocks.length > 0);
  const working = useProject(d => d.settings.working);
  const preset = PRESETS.slice(0, 3).findIndex(p => exportPresetMatches(p, ec, working));
  return (
    <div className="review-render-pane">
      <RecentPreviews />
      <div className="compact-export">
        <label>Export <select aria-label="Quick export preset" value={preset >= 0 && preset < 3 ? preset : -1} onChange={e => applyPreset(Number(e.target.value))}>
          <option value={-1} disabled>{formatLabel(ec.format)} · {ec.width}×{ec.height}</option>
          {PRESETS.slice(0, 3).map((p, i) => <option key={p.name} value={i}>{p.name} · {working.w}×{working.h}</option>)}
        </select></label>
        <button className="btn-run" disabled={!hasBlocks} onClick={() => void queueRender()} title="Render with the saved export settings and output folder"><Icon name="render" size={14} />Render</button>
        <button onClick={() => setWs('render')}>Full render workspace</button>
      </div>
    </div>
  );
}

// ---------- History drawer ----------

export function HistoryDrawer() {
  const open = useUi((s) => s.historyOpen);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setUi({ historyOpen: false });
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);
  return (
    <aside className={'fxpanel historydrawer' + (open ? ' open' : '')} aria-hidden={!open} aria-label="History">
      <div className="fh"><b>History</b><span className="dim" style={{ fontSize: 10 }}>every edit, newest first</span><button className="x" onClick={() => setUi({ historyOpen: false })} title="Close (Esc)">✕</button></div>
      {open && <HistoryPane />}
    </aside>
  );
}

// ---------- Arrange / Process ----------

export type ComposeMode = 'arrange' | 'process';
/** Stack weights per mode (the arrangement vs the graph); preview, inspector, selection, playhead stay. */
// Task layouts switch working detail; legacy bands and graph stacks retain their sizing route.
const MODE_F: Record<ComposeMode, { band: number; program: number; graph: number; edit: number }> = {
  arrange: { band: 0.34, program: 3, graph: 2, edit: 0 },
  process: { band: 0.20, program: 4, graph: 3, edit: 0 },
};

export function applyComposeMode(mode: ComposeMode, known: string[]) {
  setSettings((s) => void (s.composeMode = mode));
  openDeskDetail(mode === 'arrange' ? 'block' : 'processing');
  const m = MODE_F[mode];
  setWsLayout('mosh', (cols: WsLayout) => cols.map((c) => ({
    ...c,
    ...(c.band ? { h: m.band } : {}),
    stacks: c.stacks.map((s) => (s.panes.includes('program') ? { ...s, f: m.program, collapsed: false } : s.panes.includes('edit') ? { ...s, f: m.edit, collapsed: false } : s.panes.includes('graph') ? { ...s, f: m.graph, collapsed: false } : s)),
  })), known);
}

export function ModeToggle({ known }: { known: string[] }) {
  const mode = useSettings((s) => s.composeMode);
  return (
    <span className="seg modeseg" role="radiogroup" aria-label="Compose mode" title="Arrange: block timing tools. Process: applied processing. Preview target and selection stay.">
      {(['arrange', 'process'] as const).map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => applyComposeMode(m, known)}>{m === 'arrange' ? 'Arrange' : 'Process'}</button>
      ))}
    </span>
  );
}

/** Snap for scrubbing and marking on the slots (it lived on the removed slice timeline). */
export function SnapPick() {
  const snap = useUi((s) => s.snap);
  const bpm = useProject((d) => d.settings.bpm);
  return (
    <RadialPick
      title="Snap unit"
      className="tbtn snappick"
      value={snap}
      hint="Snap scrubbing and marking on the slots to frame / beat / bar (project BPM)"
      options={[
        { label: 'frame', value: 'frame', color: 'var(--sky)', hint: 'Every frame' },
        { label: 'beat', value: 'beat', color: 'var(--fn-interactive)', hint: `One beat at ${bpm} BPM` },
        { label: 'bar', value: 'bar', color: 'var(--coral)', hint: 'Four beats' },
      ]}
      onChange={(v) => setUi({ snap: v as 'frame' | 'beat' | 'bar' })}
      label={`snap: ${snap}`}
    />
  );
}
