import { useEffect, useMemo, useRef, useState } from 'react';
import type { Block, SourceClip } from '@moshpit/engine';
import { defOf } from '../../engine';
import { FAMILY_COLOUR } from '../../lib/cats';
import { blockFrames, blockStarts, timelineFrames } from '../../lib/timeline';
import { barsBeats, fpsValue, timecode } from '../../lib/time';
import {
  addBlock, duplicateBlock, isFrozen, moveBlock, removeSource, restoreTo, selectBlock, selectNode, setBlock, setMarks, setSettings,
  toggleFreeze, trimBlock, useHistory, useCanRedo, useProject, stepHistory, undoAction, beginGesture, endGesture, getDoc, removeBlock, 
} from '../../state/project';
import { setLoupe, setUi, setWs, uiStore, useUi } from '../../state/ui';
const uiNow = () => uiStore.get();
import { FrameView } from '../../components/FrameView';
import { ParameterTimeline } from '../../components/ParameterTimeline';
import { useSticky } from '../../state/store';
import { ConformBadge } from '../../components/ConformBadge';
import { Icon } from '../../components/Icon';
import { MediaMark, Timecode } from '../../components/MediaReadout';
import { MarkHandles, Ticks, ZoomButtons, ZoomNav, dragFrames, rulerTime, useWheelZoom, useZoom } from '../../components/TimelineKit';
import { conformFrames } from '../../lib/frames';
import { musicSteps, timeSteps } from '../../lib/ticks';
import { ParamControl } from '../../params/Param';
import { blockName, catOf, chainOrder, frameRangeOf, nodeLabel, useActive } from '../../components/nodes';
import { Empty, openContextMenu, toast, toastError, type MenuItem } from '../../qol/qol';
import { useConforms } from '../../state/conforms';
import { BlockIndex } from './TaskDesk';
import { RECIPES, applyRecipe, type Recipe } from '../../state/recipes';

const useSources = () => useProject((d) => d.resources.sources);
const loupeSource = (sources: SourceClip[], which: 'A' | 'B', src?: string) => sources.find((s) => s.id === src) ?? sources[which === 'A' ? 0 : Math.min(1, sources.length - 1)];

// ---------- Clips + Recipes (left rail) ----------

export function ClipsPane() {
  const sources = useSources();
  const loupes = useUi((s) => s.loupes);
  const conf = useConforms((s) => s.status);
  const [q, setQ] = useSticky('clips.q', '');
  const A = loupeSource(sources, 'A', loupes.A.src);
  const B = loupeSource(sources, 'B', loupes.B.src);
  const shown = sources.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="libsearch"><input placeholder={`/  search ${sources.length} project clips…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clips" /></div>
      <div className="clips">
        {shown.map((s) => (
          <div
            key={s.id}
            className={'clip' + (s === A || s === B ? ' sel' : '')}
            title="Click: show in loupe A · Shift-click: loupe B"
            onClick={(e) => setLoupe(e.shiftKey ? 'B' : 'A', { src: s.id, frame: s.marks[0]?.in ?? 0 })}
            onContextMenu={(e) => openContextMenu(e, clipMenu(s))}
          >
            <FrameView priority="background" className="thumb sm" target={{ kind: 'source', sourceId: s.id, frame: s.marks[0]?.in ?? 0 }} maxW={104} badges={false} />
            <div className="meta">
              <div className="nm">{s.name} {s === A && <span className="tag in">A</span>} {s === B && <span className="tag out">B</span>}{conf[s.id] === 'changed' && <span className="approx" title="Conforms differently than when saved; the pinned conform is still used (CONFORM_CHANGED)"> ≈</span>}{conf[s.id] === 'missing' && <span className="tag miss" title="Source file not found (MEDIA_FILE_MISSING)">missing</span>}</div>
              <div className="sub">{s.probe.width}×{s.probe.height} · {(+fpsValue(s.probe.fps).toFixed(3))} · {s.probe.codec}</div>
              <ConformBadge sourceId={s.id} />
            </div>
          </div>
        ))}
        {/* Phase 0.6: an empty project and a search that hides everything are different states. */}
        {!shown.length && (sources.length ? (
          <Empty icon="⌕" title={`No clip names match “${q}”`} cta={{ label: 'Clear search', run: () => setQ('') }}>{sources.length} clip{sources.length === 1 ? '' : 's'} in the project, hidden by the search.</Empty>
        ) : (
          <Empty icon="▤" title="No clips in the project yet" cta={{ label: 'Open IN', run: () => setWs('browse') }}>Mark a range in IN (Alt+1) and send it to A or B.</Empty>
        ))}
      </div>
    </>
  );
}


export function RecipesPane() {
  const { block, blockIndex } = useActive();
  const has = (k: string) => !!defOf(k);
  const apply = (r: Recipe) => {
    if (!block) return toast('Select a block on the arrangement first: a recipe is added to one block', { kind: 'warn' });
    const missing = r.kinds.filter((k) => !has(k));
    if (missing.length) return toast(`This recipe needs ${missing.join(', ')}, which this engine does not have`, { kind: 'warn' });
    try {
      if (!applyRecipe(block.id, r)) return; // one undo step for the whole recipe
      toast(`Applied ${r.nm} to Block ${blockIndex + 1}`, { kind: 'ok', action: undoAction() });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="reclist">
      {RECIPES.map((r) => (
        <div key={r.nm} className={'recipe' + (r.kinds.every(has) && block ? '' : ' unavailable')} aria-disabled={!block} title={block ? `Append to Block ${blockIndex + 1}: ${r.kinds.map((k) => defOf(k)?.label ?? k).join(' → ')}` : 'Select a block on the arrangement first'} onClick={() => apply(r)}>
          <div className="ri">{r.ic}</div>
          <div className="rm"><div className="rn">{r.nm}</div><div className="rd">{r.kinds.length ? null : 'motion block · '}{r.kinds.map((k) => defOf(k)?.label ?? k).join(' → ')}</div></div>
          <span className="rsrc">{r.src}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- A/B slots: their clip, length and slicing timeline (ComposePanes.SlotsPane lays them out) ----------
// Phase E (plan §5, §2b): A and B are both sliceable. Each loupe carries its own slicing timeline
// (ticks, IN/OUT handles, I/O, add-to-arrangement, zoom navigator); pane 2 and the I/O keys work on
// whichever loupe is the slice target — set by touching a loupe, or the A/B switch on pane 2.

/** The conform the loupe shows, its length in conform frames (project rate), and its marks. */
export function useLoupeClip(which: 'A' | 'B') {
  const sources = useSources();
  const conforms = useProject((d) => d.resources.conforms);
  const fps = useProject((d) => d.settings.fps);
  const l = useUi((s) => s.loupes[which]);
  const src = loupeSource(sources, which, l.src);
  const frames = src ? conformFrames(src, conforms.find((c) => c.sourceId === src.id), fps) : 1;
  const frame = Math.max(0, Math.min(frames - 1, Math.round(l.frame)));
  const set = (f: number) => src && setLoupe(which, { frame: Math.max(0, Math.min(frames - 1, Math.round(f))), src: src.id });
  return { src, frames, frame, set, fps };
}

/** Snap a frame to the project grid (frame / beat / bar), within [0, frames). */
export function useSnap(frames: number) {
  const snap = useUi((s) => s.snap);
  const fps = useProject((d) => d.settings.fps);
  const bpm = useProject((d) => d.settings.bpm);
  const beatF = (fpsValue(fps) * 60) / bpm;
  const unit = snap === 'beat' ? beatF : snap === 'bar' ? beatF * 4 : 1;
  return (f: number) => Math.max(0, Math.min(frames - 1, Math.round(Math.round(f / unit) * unit)));
}

export function addSlice(src: SourceClip, kind?: Block['kind']) {
  const mark = src.marks[0];
  if (!mark) return toast('Set IN and OUT first (I / O)', { kind: 'warn' });
  try {
    addBlock(src.id, mark.in, mark.out, kind);
    toast(`Added ${mark.out - mark.in} f slice of ${src.name} to the arrangement`, { kind: 'ok', action: undoAction() });
  } catch (e) {
    toastError(e);
  }
}

export function ClipTimeline({ which, compact = false }: { which: 'A' | 'B'; compact?: boolean }) {
  const { src, frames, frame, set, fps } = useLoupeClip(which);
  const z = useZoom(`clip:${src?.id}`, frames, frame);
  const track = useRef<HTMLDivElement>(null);
  const snapF = useSnap(frames);
  useWheelZoom(track, z);
  const steps = useMemo(() => timeSteps(fpsValue(fps)), [fps]);
  if (!src) return null;
  const { view } = z;
  const mark = src.marks[0];
  const pc = (f: number) => ((f - view.start) / view.len) * 100 + '%';
  const whole = (f: number) => (f / frames) * 100 + '%';
  // [in, out): OUT may be `frames`, so a slice can include the clip's last frame.
  const marksSet = (i: number, o: number) => setMarks(src.id, Math.max(0, i), Math.min(frames, o));
  const snapMark = (f: number) => (f >= frames - 0.5 ? frames : snapF(f));
  const thumbs = Array.from({ length: 10 }, (_, i) => Math.round(view.start + ((i + 0.5) * view.len) / 10));
  return (
    <div className={'clipzoom' + (compact ? ' compact-source-range' : '')}>
      <div className="zhead">
        <span>{which} · source timeline</span>
        <span className="ztools">
          <button className="tbtn io" title={`Set IN at this loupe's frame (${frame})`} onClick={() => marksSet(frame, Math.max(frame + 1, mark?.out ?? frame + 1))}><Icon name="mark-in" size={14} />I</button>
          <button className="tbtn io o" title={`Set OUT at this loupe's frame (${frame})`} onClick={() => marksSet(Math.min(mark?.in ?? 0, frame - 1), frame)}><Icon name="mark-out" size={14} />O</button>
          <button className="tbtn pop" disabled={!mark} title={mark ? "Append this clip's IN→OUT to the arrangement (motion; picture if it is the first block)" : 'Mark an IN and an OUT on this clip first (I, O)'} onClick={() => addSlice(src)}>⤓ block</button>
          <ZoomButtons z={z} />
        </span>
      </div>
      <div className="ztrack" ref={track} onPointerDown={(e) => dragFrames(e, track.current!, view, (f) => set(snapF(f)))} title="Click or drag to scrub · wheel to zoom · Shift+wheel to pan">
        {!compact && <div className="thumbs">{thumbs.map((t, i) => <FrameView priority="background" key={i} className="tf sm" target={{ kind: 'source', sourceId: src.id, frame: Math.min(frames - 1, t) }} maxW={72} badges={false} />)}</div>}
        {src.chapters.map((c) => <div key={c.id} className="zchap" style={{ left: pc(c.start) }} title={`Chapter cut at ${timecode(c.start, fps)}`} />)}
        {mark && <MarkHandles identity={src.id} total={frames} isCurrent={() => {
          // Read the store directly: CT may change marks before React has rendered that update.
          const current = loupeSource(getDoc().resources.sources, which, uiStore.get().loupes[which].src);
          return current?.id === src.id && current.marks[0]?.in === mark.in && current.marks[0]?.out === mark.out;
        }} view={view} marks={mark} setMarks={marksSet} snap={snapMark} track={track} />}
        <Ticks view={view} steps={steps} label={rulerTime((f) => timecode(f, fps), fpsValue(fps))} />
        <div className="zph" style={{ left: pc(frame) }} />
      </div>
      <ZoomNav total={frames} z={z}>
        {mark && <div className="znmark" style={{ left: whole(mark.in), width: whole(mark.out - mark.in) }} title="The IN–OUT slice on the whole clip" />}
        {src.chapters.map((c) => <i key={c.id} className="znchap" style={{ left: whole(c.start) }} />)}
        <i className="znph" style={{ left: whole(frame) }} />
      </ZoomNav>
      <div className="zmeta">
        <span className={'zio' + (mark ? '' : ' none')}>
          {mark ? <><MediaMark kind="in" /> <b><Timecode frame={mark.in} fps={fps} /></b> <MediaMark kind="out" /> <b><Timecode frame={mark.out} fps={fps} /></b> · {((mark.out - mark.in) / fpsValue(fps)).toFixed(2)} s</> : 'Mark In / Out with I / O, or drag on the slice timeline'}
        </span>
        <span>View <Timecode frame={view.start} fps={fps} />–<Timecode frame={view.start + view.len} fps={fps} /></span>
        <span><MediaMark kind="frames" /> {frames} · <Timecode frame={frames} fps={fps} /></span>
      </div>
    </div>
  );
}

// ---------- Arrangement ----------

/**
 * Phase 0.1a: the playhead moves 60 times a second while playing; only these tiny components follow
 * it. The arrangement used to subscribe itself and rebuild every block on every frame.
 */
function PlayheadMark({ className, at, tag = 'span' }: { className: string; at: (frame: number) => number; tag?: 'span' | 'i' }) {
  const playhead = useUi((s) => s.playhead);
  const T = tag;
  return <T className={className} style={{ left: at(playhead) * 100 + '%' }} />;
}
/** While playing, keep the playhead in view: page the arrangement when it runs off an edge. */
function PlayheadFollow({ z }: { z: ReturnType<typeof useZoom> }) {
  const out = useUi((s) => (s.playing && (s.playhead < z.view.start || s.playhead > z.view.start + z.view.len) ? s.playhead : null));
  useEffect(() => {
    if (out != null) z.setView((v) => ({ start: out - v.len / 2, len: v.len }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out]);
  return null;
}

export function EditTimeline() {
  const animationOpen = useUi(s => !!s.animation);
  const blocks = useProject((d) => d.timeline.blocks);
  const freezes = useProject((d) => d.freezes);
  const fps = useProject((d) => d.settings.fps);
  const bpm = useProject((d) => d.settings.bpm);
  const { block: active } = useActive();
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const total = timelineFrames(blocks) || 1;
  const starts = blockStarts(blocks);
  const beatF = (fpsValue(fps) * 60) / bpm;
  const bars = Math.ceil(total / (beatF * 4));
  // §2b: the arrangement has the same zoom kit as the clip timelines, on a musical ruler.
  const z = useZoom('arrangement', total);
  const viewEl = useRef<HTMLDivElement>(null);
  useWheelZoom(viewEl, z);
  const steps = useMemo(() => musicSteps(beatF), [beatF]);
  const { view } = z;

  /**
   * F1 (UX round 2): drag a block's left edge to move its IN, the right edge its OUT. Pixels map to
   * timeline frames by the track's width, then to the block's own source frames (speed and repeat
   * included); each move re-trims from where the drag began, as one undo step.
   */
  const startTrim = (e: React.PointerEvent, b: Block, edge: 'in' | 'out') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectBlock(b.id);
    const sx = e.clientX, w = trackRef.current?.getBoundingClientRect().width || 1;
    const srcPerPx = (total / w) * ((b.out - b.in) / blockFrames(b));
    const from = b[edge];
    const move = (ev: PointerEvent) => trimBlock(b.id, { [edge]: from + Math.round((ev.clientX - sx) * srcPerPx) });
    beginGesture();
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up), window.removeEventListener('pointercancel', up), endGesture());
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const startDrag = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.frz, .trimh')) return;
    const sx = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - sx) > 6) {
        moved = true;
        setDragFrom(i);
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragFrom(null);
      if (!moved) {
        selectBlock(blocks[i].id);
        const first = chainOrder(blocks[i]).find((n) => n.kind === 'group.container' || defOf(n.kind)?.category === 'Mosh' || defOf(n.kind)?.category === 'Effect');
        if (first) selectNode(blocks[i].id, first.id);
        return;
      }
      const els = [...(trackRef.current?.querySelectorAll('.blk') ?? [])];
      let to = els.findIndex((el) => ev.clientX < el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2);
      if (to < 0) to = els.length - 1;
      else if (to > i) to -= 1;
      if (to !== i) moveBlock(i, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Delete removes the selected block only while the arrangement has focus: the node graph shares
  // the workspace now, and its Delete removes nodes.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const t = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || document.querySelector('[role=alertdialog]')) return;
    const b = active && getDoc().timeline.blocks.find((x) => x.id === active.id);
    if (!b) return;
    e.preventDefault();
    deleteBlockNow(b.id, getDoc().timeline.blocks.indexOf(b));
  };

  if (!blocks.length) {
    // The empty arrangement is a place to start, not dead canvas: one click adds the target slot's IN→OUT.
    const target = uiNow().sliceTarget;
    const src = getDoc().resources.sources.find((x) => x.id === uiNow().loupes[target].src) ?? getDoc().resources.sources[target === 'A' ? 0 : Math.min(1, getDoc().resources.sources.length - 1)];
    return (
      <Empty icon="▭" title="The arrangement is empty" cta={src?.marks[0] ? { label: `＋ Add block from slot ${target} (${src.name})`, run: () => addSlice(src) } : undefined}>
        {src ? 'Mark IN / OUT on a slot (I / O), then add it as a block — or right-click a clip.' : 'Send a selection to slot A or B from ① IN (Alt+1) first.'}
      </Empty>
    );
  }
  return (
    <div className={'tl' + (animationOpen ? ' has-animation' : '')} tabIndex={-1} onKeyDown={onKey} onPointerDownCapture={(e) => { if (!(e.target as HTMLElement).closest('.parameter-timeline')) (e.currentTarget as HTMLElement).focus({ preventScroll: true }); }}>
      <PlayheadFollow z={z} />
      <div className="tlview" ref={viewEl}>
      <div className="bpmruler" onPointerDown={(e) => dragFrames(e, e.currentTarget as HTMLElement, view, (f) => setUi({ playhead: Math.max(0, Math.min(total - 1, Math.round(f))) }))} title="Click or drag to move the playhead · wheel to zoom · Shift+wheel to pan">
        <Ticks view={view} steps={steps} label={(f) => { const b = Math.round(f / beatF); return b % 4 ? `${Math.floor(b / 4) + 1}.${(b % 4) + 1}` : String(b / 4 + 1); }} className="music" />
        <PlayheadMark className="tph" at={(f) => (f - view.start) / view.len} />
      </div>
      <div className="tlinner" style={{ width: (total / view.len) * 100 + '%', transform: `translateX(${(-view.start / total) * 100}%)` }}>
      <div className="track" ref={trackRef} onContextMenu={(e) => e.target === e.currentTarget && openContextMenu(e, timelineMenu(z.fit))}>
        {blocks.map((b, i) => {
          const frozen = isFrozen({ freezes } as never, { kind: 'block', blockId: b.id });
          const chain = chainOrder(b).filter((n) => n.kind === 'group.container' || ['Mosh', 'Effect'].includes(defOf(n.kind)?.category ?? '')); // a look (container) counts
          return (
            <div
              key={b.id}
              data-block={b.id}
              className={'blk ' + (b.kind === 'picture' ? 'pic' : 'mot') + (b.id === active?.id ? ' sel' : '') + (frozen ? ' frozen' : '') + (dragFrom === i ? ' dragging' : '')}
              style={{ flexGrow: blockFrames(b), flexBasis: 0 }}
              onPointerDown={(e) => startDrag(e, i)}
              onContextMenu={(e) => (selectBlock(b.id), openContextMenu(e, blockMenu(b, i, blocks.length)))}
              title={`${blockName(b, i)} · ${b.out - b.in} f ×${b.repeat} · starts ${barsBeats(starts[i], fps, bpm)} — click to edit, drag to reorder, right-click for more, Delete removes it`}
              role="button"
              aria-pressed={b.id === active?.id}
            >
              <span
                className="frz"
                title="Freeze / re-render this block to a cached clip (L25)"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const now = await toggleFreeze({ kind: 'block', blockId: b.id }, frameRangeOf(getDoc().timeline.blocks, b));
                    toast(now ? `Froze Block ${i + 1} → cached render` : `Unfroze Block ${i + 1}`, { kind: 'ok' });
                  } catch (err) {
                    toastError(err);
                  }
                }}
              ><Icon name="freeze" size={12} /></span>
              {/* Dense on a short lane (Waxy): kind + repeat on one line, the chain named, not only dotted. */}
              <div className="bhead"><span className="kind">{b.kind}</span><span className="rep">{'×' + b.repeat}</span></div>
              <div className="chain">
                {chain.map((n) => <span key={n.id} className="cdot" style={{ background: defOf(n.kind)?.family ? FAMILY_COLOUR[defOf(n.kind)!.family!] : catOf(n).accent }} title={nodeLabel(n)} />)}
                <span className="cnames">{chain.length ? chain.map((n) => nodeLabel(n)).join(' › ') : 'no effects'}</span>
              </div>
              {/* HUD readout (§12.8 per-block): index, length in bars, the source range it plays. */}
              <div className="bro" title={`Block ${i + 1} · ${blockFrames(b)} frames on the arrangement · source ${timecode(b.in, fps)}–${timecode(b.out, fps)}`}>
                <i>BLK {i + 1}</i><b>{((blockFrames(b) / fpsValue(fps)) * (bpm / 60) / 4).toFixed(2)}</b><i>BARS</i><b>{blockFrames(b)}</b><i>F</i><span className="brange"><Timecode frame={b.in} fps={fps} />→<Timecode frame={b.out} fps={fps} /></span>
              </div>
              <span className="trimh l" onPointerDown={(e) => startTrim(e, b, 'in')} title="Drag to trim the start (IN)" />
              <span className="trimh r" onPointerDown={(e) => startTrim(e, b, 'out')} title="Drag to trim the end (OUT)" />
              {frozen && <span className="frzbadge">cached</span>}
              {b.audio.mute && <span className="mutebadge" title="Clip audio muted">🔇</span>}
            </div>
          );
        })}
      </div>
      </div>
      </div>
      <div className="tlnav">
        <ZoomNav total={total} z={z} title="Arrangement navigator: drag the window to pan, its edges to zoom, click to jump">
          {blocks.map((b, i) => <i key={b.id} className={'znblk ' + (b.kind === 'picture' ? 'pic' : 'mot') + (b.id === active?.id ? ' cur' : '')} style={{ left: (starts[i] / total) * 100 + '%', width: (blockFrames(b) / total) * 100 + '%' }} />)}
          <PlayheadMark className="znph" tag="i" at={(f) => f / total} />
        </ZoomNav>
        <ZoomButtons z={z} />
      </div>
      <div className="bpm" hidden={animationOpen}>
        <span>grid </span>
        <ParamControl variant="mini" fieldKey="project|bpm" spec={{ label: 'BPM', type: 'int', min: 60, max: 200, step: 1, default: 124, help: 'Project tempo: the musical grid every beat-based value follows' }} value={bpm} onChange={(v) => setSettings({ bpm: v as number }, `BPM → ${v}`)} />
        <span>·</span><span><b>drag</b> reorder</span><span>·</span><span><Timecode frame={total} fps={fps} /> · {bars} bars</span>
        <span>·</span><span className="units-link">units ♪ bars/beats (default)</span>
      </div>
      <BlockIndex />
      <ParameterTimeline view={view} />
    </div>
  );
}

/** Delete is undoable, so it acts at once and offers Undo (the 🗑 button still asks first). */
function deleteBlockNow(id: Block['id'], index: number) {
  removeBlock(id);
  toast(`Deleted Block ${index + 1}`, { action: undoAction() });
}

function blockMenu(b: Block, i: number, count: number): (MenuItem | '-')[] {
  const frozen = isFrozen(getDoc(), { kind: 'block', blockId: b.id });
  return [
    { label: 'Open graph', run: () => (selectBlock(b.id), setWs('node')), hint: 'Alt+G' },
    { label: b.kind === 'picture' ? 'Make motion (P-frames, smears)' : 'Make picture (keyframe, hard cut)', disabled: b.kind === 'picture' && i === 0, hint: b.kind === 'picture' && i === 0 ? 'The first block must be a picture block' : undefined, run: () => setBlock(b.id, { kind: b.kind === 'picture' ? 'motion' : 'picture' }, `Block ${i + 1} → ${b.kind === 'picture' ? 'motion' : 'picture'}`) },
    { label: frozen ? 'Unfreeze' : 'Freeze (cache the render)', run: () => void toggleFreeze({ kind: 'block', blockId: b.id }, frameRangeOf(getDoc().timeline.blocks, b)).catch(toastError) },
    { label: b.audio.mute ? 'Unmute clip audio' : 'Mute clip audio', run: () => setBlock(b.id, { mute: !b.audio.mute }, b.audio.mute ? 'Unmuted clip audio' : 'Muted clip audio') },
    '-',
    { label: 'Move left', disabled: i === 0, run: () => moveBlock(i, i - 1) },
    { label: 'Move right', disabled: i === count - 1, run: () => moveBlock(i, i + 1) },
    { label: 'Duplicate', run: () => (duplicateBlock(b.id), toast(`Duplicated Block ${i + 1}`, { action: undoAction() })) },
    '-',
    { label: 'Delete block', danger: true, hint: 'Delete', run: () => deleteBlockNow(b.id, i) },
  ];
}

function timelineMenu(fit: () => void): (MenuItem | '-')[] {
  const d = getDoc();
  const ui = uiNow();
  const from = (w: 'A' | 'B') => {
    const s = d.resources.sources.find((x) => x.id === ui.loupes[w].src) ?? d.resources.sources[w === 'A' ? 0 : Math.min(1, d.resources.sources.length - 1)];
    return { label: s ? `Add loupe ${w}'s IN→OUT (${s.name})` : `Add loupe ${w}'s slice`, disabled: !s?.marks[0], run: () => s && addSlice(s) };
  };
  return [from('A'), from('B'), '-', { label: 'Fit the whole arrangement', run: fit }];
}

function clipMenu(s: SourceClip): (MenuItem | '-')[] {
  return [
    { label: 'Show in loupe A', run: () => (setLoupe('A', { src: s.id, frame: s.marks[0]?.in ?? 0 }), setUi({ sliceTarget: 'A' })) },
    { label: 'Show in loupe B', run: () => (setLoupe('B', { src: s.id, frame: s.marks[0]?.in ?? 0 }), setUi({ sliceTarget: 'B' })) },
    { label: 'Add its IN→OUT to the arrangement', disabled: !s.marks[0], run: () => addSlice(s) },
    '-',
    { label: 'Remove from project', danger: true, run: () => (removeSource(s.id) ? toast(`Removed ${s.name}`, { action: undoAction() }) : toast(`${s.name} is still used by a block — delete those blocks first`, { kind: 'warn' })) },
  ];
}

// ---------- History ----------

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

export function HistoryPane() {
  const past = useHistory(), canRedo = useCanRedo();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="history">
      <div className="histtools">
        <button className="ghostbtn" disabled={!past.length} onClick={() => stepHistory(true)} title={past.length ? 'Undo the newest step (Ctrl+Z)' : 'Nothing to undo yet'}>↶ Undo</button>
        <button className="ghostbtn" disabled={!canRedo} onClick={() => stepHistory(false)} title={canRedo ? 'Redo (Ctrl+Shift+Z)' : 'Nothing to redo'}>↷ Redo</button>
        <span className="dim">{past.length} / 200 steps</span>
      </div>
      {!past.length && <Empty icon="↶" title="No edits yet">Every edit lands here. Same-field drags merge into one step.</Empty>}
      {[...past].reverse().map((h, ri) => {
        const i = past.length - 1 - ri;
        return (
          <button key={h.at + ':' + i} className={'hitem' + (ri === 0 ? ' cur' : '')} onClick={() => ri !== 0 && restoreTo(i)} title={ri === 0 ? 'Latest edit' : 'Restore to just before this edit (undoable)'}>
            <span className="dot" />
            <div><div className="ht">{h.label}</div><div className="hs">{ago(h.at)} ago{ri === 0 ? ' · current' : ' · click to restore'}</div></div>
          </button>
        );
      })}
    </div>
  );
}

