import { useEffect, useRef, useState } from 'react';
import type { ParamDef } from '@moshpit/engine';
import { useActive, nodeLabel } from './nodes';
import { getDoc, isFrozen, useProject } from '../state/project';
import { changeEnvelope, envelopeParams, focusAnimation } from '../state/animation';
import { setUi, useUi } from '../state/ui';
import { getProjectSession } from '../state/jobs';
import { readEnvelope, evaluateEnvelope, type Envelope } from '../lib/parameterEnvelope';
import { blockFrames, blockStarts } from '../lib/timeline';
import { rangeDrag } from '../lib/rangeDrag';
import { fpsValue } from '../lib/time';
import { timeSteps } from '../lib/ticks';
import { Ticks, type View } from './TimelineKit';
import { confirmAction, toastError } from '../qol/qol';
import './parameter-timeline.css';

const attempt = (fn: () => void) => { try { fn(); } catch (e) { toastError(e); } };
const easeNames = { linear: 'Linear', in: 'Ease in', out: 'Ease out', smooth: 'Smooth' } as const;

/** A selected-node lane in the existing arrangement, on its frame ruler and zoom. */
export function ParameterTimeline({ view }: { view: View }) {
  const { block, selected: node } = useActive();
  const focus = useUi(s => s.animation);
  const frame = useUi(s => s.playhead);
  const fps = useProject(d => fpsValue(d.settings.fps));
  const doc = useProject(d => d);
  const [animatedOnly, setAnimatedOnly] = useState(false);
  const [point, setPoint] = useState<'start' | 'end'>('start');
  const [dragDraft, setDragDraft] = useState<{ target: string; value: Envelope } | null>(null);
  const graph = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const params = node ? envelopeParams(node) : [];
  const visible = animatedOnly ? params.filter(p => !!node?.bindings[p.key]?.expression) : params;
  const p = visible.find(p => focus?.nodeId === node?.id && focus?.blockId === block?.id && p.key === focus?.key) ?? visible[0];
  const binding = node && p ? node.bindings[p.key] : undefined;
  const target = `${getProjectSession()}|${block?.id}|${node?.id}|${p?.key}`;
  const envelope = dragDraft?.target === target ? dragDraft.value : readEnvelope(binding);
  const frozen = !!block && isFrozen(doc, { kind: 'block', blockId: block.id });
  useEffect(() => () => cleanup.current?.(), [block?.id, node?.id, p?.key]);
  if (!block || !node || !params.length) return focus ? <div className="animation-empty">◇ Select Hue rotate or an effect’s Wet parameter to animate. <button onClick={() => setUi({ animation: undefined })}>Close</button></div> : null;
  const select = (key: string) => setUi({ animation: { blockId: block.id, nodeId: node.id, key } });
  if (!focus) return <button className="animation-open" onClick={() => focusAnimation(block.id, node.id, params[0].key)}>◇ Animate {nodeLabel(node)}</button>;
  const change = (patch: Partial<Envelope>) => envelope && p && attempt(() => changeEnvelope(block.id, node.id, p.key, { ...envelope, ...patch }));
  const enable = async () => {
    if (!p) return;
    const session = getProjectSession();
    if ((binding?.expression || binding?.lfo || binding?.value) && !await confirmAction('Use a timeline curve?',
      'The curve overrides this parameter’s Formula, LFO or Value while active. Restore source brings back the exact previous formula and links.', 'Use curve')) return;
    // A selection/project change while the dialog is open cannot target a different value.
    if (session !== getProjectSession() || getDoc() !== doc) return;
    const start = blockStarts(doc.timeline.blocks)[doc.timeline.blocks.indexOf(block)] / fps;
    const base = Number(node.params[p.key] ?? p.default);
    attempt(() => changeEnvelope(block.id, node.id, p.key, {
      version: 1, start, end: start + Math.max(1, blockFrames(block)) / fps,
      from: base, to: base, ease: 'smooth', hue: 'direct',
    }, true));
  };
  const startDrag = (event: React.PointerEvent<HTMLButtonElement>, which: 'start' | 'end') => {
    if (event.button !== 0 || !envelope || !p || frozen) return;
    event.preventDefault(); event.stopPropagation();
    cleanup.current?.(); select(p.key); setPoint(which);
    const original = envelope, session = getProjectSession(), before = getDoc();
    let candidate = original;
    const width = graph.current?.getBoundingClientRect().width ?? 1;
    const origin = envelope[which], duration = view.len / fps;
    const min = which === 'start' ? 0 : envelope.start + 1 / fps;
    const max = which === 'start' ? envelope.end - 1 / fps : Infinity;
    // Preview the curve locally; commit once on release. A cancelled/no-op gesture must
    // leave both Undo and Redo intact, and concurrent edits must not be overwritten.
    cleanup.current = rangeDrag({ target: event.currentTarget, pointerId: event.pointerId, startX: event.clientX,
      current: () => session === getProjectSession() && getDoc() === before,
      move: dx => {
        const deltaFrames = Math.round(dx / width * duration * fps);
        candidate = deltaFrames === 0 ? original : { ...original,
          [which]: Math.max(min, Math.min(max, Math.round(origin * fps + deltaFrames) / fps)),
        };
        setDragDraft({ target, value: candidate });
      },
      restore: () => setDragDraft(null),
      end: cancelled => {
        cleanup.current = undefined; setDragDraft(null);
        if (!cancelled && session === getProjectSession() && getDoc() === before && candidate[which] !== original[which]) {
          attempt(() => changeEnvelope(block.id, node.id, p.key, candidate));
        }
      },
    });
  };
  const min = p?.min ?? 0, max = p?.max ?? 1;
  const x = (seconds: number) => (seconds * fps - view.start) / view.len * 100;
  const y = (value: number) => 88 - (value - min) / Math.max(1e-9, max - min) * 72;
  const plot = envelope ? Array.from({ length: 121 }, (_, i) => {
    const t = (view.start + view.len * i / 120) / fps;
    return `${i / 120 * 1000},${y(evaluateEnvelope(envelope, t))}`;
  }).join(' ') : '';
  const updateTime = (v: number) => change({ [point]: Math.round(v * fps) / fps });
  const valueKey = point === 'start' ? 'from' : 'to';
  // A CT/project selection can change while a draft field has focus. Never carry that
  // uncommitted text into another target, even when their displayed numbers are equal.
  const editIdentity = `${getProjectSession()}|${block.id}|${node.id}|${p?.key}|${point}`;
  return <section className="parameter-timeline" aria-label="Parameter animation" onKeyDown={e => { if (e.key === 'Delete' || e.key === 'Backspace') e.stopPropagation(); }} onPointerDown={e => e.stopPropagation()}>
    <header><strong>{nodeLabel(node)}</strong><nav aria-label="Parameter lanes">{visible.map(param => <button key={param.key} className={param.key === p?.key ? 'active' : ''} aria-pressed={param.key === p?.key} onClick={() => select(param.key)}>
      {node.bindings[param.key]?.expression ? '◆' : '◇'} {param.label}
    </button>)}</nav><button aria-pressed={animatedOnly} onClick={() => setAnimatedOnly(!animatedOnly)}>{animatedOnly ? 'Animated' : 'All parameters'}</button><button aria-label="Close parameter lanes" onClick={() => setUi({ animation: undefined })}>×</button></header>
    {!p ? <span className="animation-empty">No animated parameters on this node.</span> : <>
      <div className="animation-source"><span>{envelope ? 'Curve' : binding?.expression ? 'Custom formula' : binding?.lfo ? 'LFO' : binding?.value ? 'Value' : 'Manual'}</span>
        <span>Timeline seconds{envelope ? ' · 2 points · hold ends' : ''}{envelope && (binding?.lfo || binding?.value) ? ' · overrides linked source' : ''}</span>
        <button disabled={frozen} onClick={() => envelope ? attempt(() => changeEnvelope(block.id, node.id, p.key, null)) : void enable()}>{envelope ? 'Restore source' : 'Add curve'}</button>
      </div>
      {envelope ? <>
        <div className="animation-ruler"><Ticks view={view} steps={timeSteps(fps)} label={f => `${Number((f / fps).toFixed(2))}s`} /></div>
        <div className="animation-plot" ref={graph} aria-label={`${p.label} curve, timeline seconds`}>
          <svg viewBox="0 0 1000 104" preserveAspectRatio="none" aria-hidden="true"><path className="animation-grid" d="M0 16H1000 M0 52H1000 M0 88H1000"/><polyline points={plot}/></svg>
          <small className="animation-max">{displayValue(p, max)}</small><small className="animation-min">{displayValue(p, min)}</small>
          <i className="animation-playhead" style={{ left: `${x(frame / fps)}%` }} />
          {(['start', 'end'] as const).map(which => <button key={which} className={'animation-key ' + (point === which ? 'selected' : '')}
            style={{ left: `${x(envelope[which])}%`, top: `${y(evaluateEnvelope(envelope, envelope[which])) / 104 * 100}%` }}
            disabled={frozen} aria-label={`${which} keyframe`} aria-pressed={point === which}
            title={`${which}: ${envelope[which]} s · drag time, use fields for values`}
            onClick={() => setPoint(which)} onPointerDown={e => startDrag(e, which)}
            onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setPoint(which); change({ [which]: envelope[which] + (e.key === 'ArrowRight' ? 1 : -1) / fps }); } }}>◆</button>)}
        </div>
        <div className="animation-controls">
          <select aria-label="Selected endpoint" value={point} onChange={e => setPoint(e.target.value as typeof point)}><option value="start">Start ◆</option><option value="end">End ◆</option></select>
          <ExactNumber key={`${editIdentity}|time`} label="Time (seconds)" value={envelope[point]} disabled={frozen} onCommit={updateTime}/><span>s</span>
          <ExactNumber key={`${editIdentity}|value`} label={`${p.label} value`} value={envelope[valueKey]} disabled={frozen} onCommit={v => change({ [valueKey]: v })}/><span>{p.unit || 'value'}</span>
          <select aria-label="Easing" disabled={frozen} value={envelope.ease} onChange={e => change({ ease: e.target.value as Envelope['ease'] })}>{Object.entries(easeNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>
          {node.kind === 'fx.hue-rotate' && p.key === 'degrees' && <select aria-label="Hue path" disabled={frozen} value={envelope.hue} onChange={e => change({ hue: e.target.value as Envelope['hue'] })}><option value="direct">Direct hue</option><option value="shortest">Shortest hue</option></select>}
        </div>
      </> : binding?.expression && <details className="animation-formula"><summary>Formula</summary><code>{binding.expression.source}</code></details>}
      <details className="animation-help"><summary>Timing &amp; sources</summary><p>Curves hold their first and last values. Times belong to the whole timeline; moving, trimming or repeating a block does not restart them. Knobs edit the manual base, not these curve points. Restore source returns to the previous formula or linked/manual value.</p></details>
    </>}
  </section>;
}

function displayValue(p: ParamDef, v: number) { return `${Number(v.toFixed(2))}${p.unit ?? ''}`; }

function ExactNumber({ label, value, onCommit, disabled }: { label: string; value: number; onCommit: (v: number) => void; disabled: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const save = () => { const v = Number(text); if (text.trim() && Number.isFinite(v) && v !== value) onCommit(v); setText(String(value)); };
  return <input aria-label={label} type="text" inputMode="decimal" disabled={disabled} value={text} onChange={e => setText(e.target.value)} onBlur={save}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') { e.preventDefault(); setText(String(value)); } }} />;
}
