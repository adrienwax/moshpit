// Extracted from Moshpit Param.tsx. Controlled UI only; consumers own history, clocks and preferences.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MUSDIV, fmtBeats } from './musicalTime';
import './parameter.css';
export interface ParamSpec {
  label: string; type: string; min?: number; max?: number; step?: number; unit?: string;
  options?: readonly string[]; default: unknown; initial?: unknown; help?: string;
}
export interface GestureCallbacks { onGestureStart?: () => void; onGestureEnd?: () => void }
export interface NumberFieldProps extends GestureCallbacks {
  spec: ParamSpec; value: number; onChange: (v: number) => void; className?: string; ariaLabel: string; title?: string;
}
interface CommonProps {
  spec: ParamSpec; value: unknown; fieldKey: string; variant: 'mini' | 'full'; mod?: string;
  bpm: number; seconds: boolean;
}
export interface EnumRenderProps { spec: ParamSpec; value: string; options: readonly string[]; onChange: (v: string) => void }
interface EditProps extends CommonProps, GestureCallbacks {
  mode: 'edit'; onChange: (v: number | boolean | string) => void; disabled?: boolean;
  resetValue?: unknown; onToggleUnits?: () => void; renderEnum?: (p: EnumRenderProps) => ReactNode;
}
interface InspectProps extends CommonProps {
  mode: 'inspect'; onChange?: never; onGestureStart?: never; onGestureEnd?: never;
  onToggleUnits?: never; renderEnum?: never; resetValue?: never;
  unavailable?: string;
}
export type MpParameterFieldProps = EditProps | InspectProps;
const supported = (type: string) => ['float', 'int', 'bool', 'enum', 'beats'].includes(type);
export function inspectValue(spec: ParamSpec, value: unknown, bpm: number, seconds: boolean, raw = false): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'number' && Number.isFinite(value) && !raw && (spec.type === 'float' || spec.type === 'beats' || (spec.type === 'int' && Number.isInteger(value)))) {
    if (spec.type === 'beats' && seconds && !(Number.isFinite(bpm) && bpm > 0)) return `${value} beats · BPM unavailable`;
    return fmtValue(spec, value, bpm, seconds);
  }
  if (value === '') return '\"\"';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
/** Inspect is a separate inert tree: even callbacks smuggled through JS cannot become handlers. */
export function MpParameterField(props: MpParameterFieldProps) {
  if (props.mode === 'inspect' || !supported(props.spec.type)) return (
    <div className={'mp-parameter-inspect ' + (props.variant === 'mini' ? 'npm' : 'param')} data-field-key={props.fieldKey}>
      <span className={props.variant === 'mini' ? 'pnm' : 'pl'} title={props.spec.help}>{props.spec.label}</span>
      <output className="mp-param-readout" aria-label={props.spec.label}>
        {inspectValue(props.spec, props.value, props.bpm, props.seconds, props.mode === 'inspect' && !!props.unavailable)}
      </output>
      {props.mode === 'inspect' && props.unavailable && <small className="mp-param-unavailable">{props.unavailable}</small>}
      {props.mod && <small className="modtag">{props.mod}</small>}
      {!supported(props.spec.type) && <small>Unsupported type: {props.spec.type}</small>}
    </div>
  );
  return <EditParameterField {...props} />;
}

const range = (s: ParamSpec) => ({ min: s.min ?? 0, max: s.max ?? 1 });

function divRange(s: ParamSpec) {
  const lo = MUSDIV.findIndex((d) => d.beats >= (s.min ?? 0));
  let hi = MUSDIV.length - 1;
  while (hi > 0 && MUSDIV[hi].beats > (s.max ?? 32)) hi--;
  return { lo: Math.max(0, lo), hi };
}
const nearestDiv = (beats: number) => MUSDIV.reduce((b, d, i) => (Math.abs(d.beats - beats) < Math.abs(MUSDIV[b].beats - beats) ? i : b), 0);

const unitSuffix = (spec: ParamSpec) => (spec.unit ? (spec.unit === '°' || spec.unit === '%' ? spec.unit : ' ' + spec.unit) : '');

export function fmtValue(spec: ParamSpec, v: number, bpm: number, seconds: boolean): string {
  if (spec.type === 'beats') return fmtBeats(v, bpm, seconds);
  if (spec.unit === '%') {
    const magnitude = Math.abs(v);
    if (magnitude > 0 && magnitude < 0.0001) return v < 0 ? '>−0.0001%' : '<0.0001%';
    return `${Number(magnitude > 0 && magnitude < 1 ? v.toPrecision(2) : v.toFixed(1))}%`;
  }
  const { max } = range(spec);
  const u = spec.unit;
  let d = spec.type === 'int' || u === '%' || u === '°' || u === 'f' || u === 'px' ? 0 : max <= 1 ? 2 : max <= 5 ? 1 : 0;
  // Never round a value away: a typed 137.43 % used to read "137%". Show up to four decimals
  // when the stored value has them.
  if (spec.type !== 'int') while (d < 4 && Math.abs(v - +v.toFixed(d)) > 1e-9) d++;
  return v.toFixed(d) + unitSuffix(spec);
}

/** One keyboard step: the param's own step (1 for an int), else a hundredth of the range. */
function keyStep(spec: ParamSpec): number {
  if (spec.step) return spec.step;
  if (spec.type === 'int') return 1;
  const { min, max } = range(spec);
  return (max - min) / 100;
}

/**
 * A typed value → the stored number: clamped to the range, an int rounded, a float kept as typed
 * (not snapped to the drag step: typing is for exact values). Beats are typed in beats, or in
 * seconds when the field shows seconds. A trailing unit is allowed. NaN when it is not a number.
 */
export function parseTyped(spec: ParamSpec, text: string, bpm: number, seconds: boolean): number {
  const t = text.trim().replace(',', '.').replace(/\s*(%|°|s|f|px|bpm|×|x|beats?)$/i, '');
  let v = Number(t);
  if (!t || !Number.isFinite(v)) return NaN;
  if (spec.type === 'beats' && seconds) v = (v * bpm) / 60;
  if (spec.type === 'int') v = Math.round(v);
  const { min, max } = range(spec);
  return Math.max(min, Math.min(max, +v.toFixed(6)));
}

/** Fraction 0..1 of the control's travel. Beats travel over musical divisions, not raw beats. */
function fraction(spec: ParamSpec, v: number) {
  if (spec.type === 'beats') {
    const { lo, hi } = divRange(spec);
    return hi > lo ? (nearestDiv(v) - lo) / (hi - lo) : 0;
  }
  const { min, max } = range(spec);
  return Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
}

function fromFraction(spec: ParamSpec, f: number): number {
  f = Math.max(0, Math.min(1, f));
  if (spec.type === 'beats') {
    const { lo, hi } = divRange(spec);
    return MUSDIV[Math.round(lo + f * (hi - lo))].beats;
  }
  const { min, max } = range(spec);
  const step = spec.step ?? (spec.type === 'int' ? 1 : 0.01);
  const v = min + f * (max - min);
  return Math.max(min, Math.min(max, +(Math.round(v / step) * step).toFixed(6)));
}

/**
 * Relative scrub: drag ↔ to change, Shift = fine (×0.1), Alt = coarse (×4). A click without
 * movement on the track jumps there; on the value readout it opens typing (`onType`). Arrow keys
 * (←→ and ↑↓) step by the param's step, Shift ÷10, Alt ×10; Enter types. Right-click (or a
 * double-click on the track) resets to the default.
 */
function useScrub(spec: ParamSpec, v: number, onChange: (v: number) => void, disabled?: boolean, onType?: () => void, gestures: GestureCallbacks = {}, resetValue?: unknown) {
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  useEffect(() => { if (disabled) cancelDrag.current?.(); }, [disabled]);
  const onPointerDown = (e: React.PointerEvent<HTMLElement>, jump: boolean) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag.current?.();
    const el = e.currentTarget, pointerId = e.pointerId;
    try { el.setPointerCapture(pointerId); } catch { return; }
    const rect = el.getBoundingClientRect();
    const sx = e.clientX;
    let f0 = fraction(spec, v), x0 = sx, gain = e.shiftKey ? 0.1 : e.altKey ? 4 : 1;
    let moved = false, finished = false;
    const previousCursor = document.body.style.cursor;
    gestures.onGestureStart?.(); // the whole drag is one undo step, however slow (a 1.5 s pause used to split it)
    document.body.style.cursor = 'ew-resize';
    const move = (ev: PointerEvent) => {
      if (finished || ev.pointerId !== pointerId) return;
      const g = ev.shiftKey ? 0.1 : ev.altKey ? 4 : 1;
      if (g !== gain) {
        // A modifier pressed mid-drag changes the rate from here on, without a jump.
        f0 = f0 + ((ev.clientX - x0) / 220) * gain;
        x0 = ev.clientX;
        gain = g;
      }
      if (Math.abs(ev.clientX - sx) > 2) moved = true;
      if (!moved) return;
      onChange(fromFraction(spec, f0 + ((ev.clientX - x0) / 220) * gain));
    };
    const cleanup = () => {
      if (finished) return;
      finished = true;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      window.removeEventListener('blur', cleanup);
      if (document.body.style.cursor === 'ew-resize') document.body.style.cursor = previousCursor;
      if (cancelDrag.current === cleanup) cancelDrag.current = null;
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      gestures.onGestureEnd?.();
    };
    const up = (ev: PointerEvent) => {
      if (finished || ev.pointerId !== pointerId) return;
      cleanup();
      if (moved || ev.type !== 'pointerup') return;
      if (jump) onChange(fromFraction(spec, (ev.clientX - rect.left) / rect.width));
      else onType?.();
    };
    cancelDrag.current = cleanup;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    window.addEventListener('blur', cleanup);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'Enter' && onType) {
      e.preventDefault();
      return onType();
    }
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (spec.type === 'beats') {
      const { lo, hi } = divRange(spec);
      return onChange(MUSDIV[Math.max(lo, Math.min(hi, nearestDiv(v) + dir))].beats);
    }
    const step = keyStep(spec) * (e.shiftKey ? 0.1 : e.altKey ? 10 : 1);
    const { min, max } = range(spec);
    const next = spec.type === 'int' ? Math.round(v + dir * Math.max(1, step)) : +(v + dir * step).toFixed(6);
    onChange(Math.max(min, Math.min(max, next)));
  };
  const reset = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // a node's own right-click menu stays out of the way
    const back = resetValue ?? spec.initial ?? spec.default; // U2: reset is where a new node starts
    if (!disabled && typeof back === 'number' && back !== v) onChange(back);
  };
  return { onPointerDown, onKeyDown, onDoubleClick: reset, onContextMenu: reset };
}

/** The typed-value editor that stands in for a readout while open. Enter / blur sets, Esc cancels. */
function TypeIn({ spec, v, bpm, seconds, onChange, onDone, className }: { spec: ParamSpec; v: number; bpm: number; seconds: boolean; onChange: (v: number) => void; onDone: () => void; className: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const shownNum = spec.type === 'beats' && seconds ? +((v * 60) / bpm).toFixed(4) : v;
  const [text, setText] = useState(String(shownNum));
  const [bad, setBad] = useState(false);
  const closed = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const close = () => {
    closed.current = true;
    onDone();
  };
  const commit = () => {
    if (closed.current) return;
    const n = parseTyped(spec, text, bpm, seconds);
    if (Number.isNaN(n)) return setBad(true); // stay open and say so, rather than drop the edit
    if (n !== v) onChange(n);
    close();
  };
  const { min, max } = range(spec);
  const unit = spec.type === 'beats' ? (seconds ? 's' : 'beats') : spec.unit ?? '';
  return (
    <input
      ref={ref}
      className={className + ' typein nodrag' + (bad ? ' bad' : '')}
      value={text}
      inputMode="decimal"
      spellCheck={false}
      aria-label={`${spec.label}: type a value`}
      aria-invalid={bad}
      title={`${bad ? 'Not a number. ' : ''}Type a value${unit ? ' in ' + unit : ''}, ${min} to ${max}. Enter sets it, Esc cancels`}
      onChange={(e) => (setText(e.target.value), setBad(false))}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation(); // typing never reaches the app's shortcuts (I, O, Space, Delete…)
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') close();
      }}
      onBlur={() => (bad ? close() : commit())}
    />
  );
}

/**
 * A bare number with a param readout's behaviour (click to type, drag, arrows, right-click reset),
 * for numbers that live outside a node, like the transport's BPM.
 */
export function MpNumberField({ spec, value, onChange, className = '', ariaLabel, title, onGestureStart, onGestureEnd }: NumberFieldProps) {
  const [typing, setTyping] = useState(false);
  const scrub = useScrub(spec, value, onChange, false, () => setTyping(true), { onGestureStart, onGestureEnd });
  if (typing) return <TypeIn spec={spec} v={value} bpm={120} seconds={false} onChange={onChange} onDone={() => setTyping(false)} className={className} />;
  return (
    <span
      className={className + ' mp-number-field scrubnum'}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      title={`${title ? title + ' · ' : ''}Click to type · drag ↔ (Shift fine, Alt coarse) · right-click resets`}
      onPointerDown={(e) => scrub.onPointerDown(e, false)}
      onKeyDown={scrub.onKeyDown}
      onContextMenu={scrub.onContextMenu}
    >
      {fmtValue(spec, value, 120, false)}
    </span>
  );
}

function EditParameterField({ spec, value, onChange, fieldKey, variant, mod, disabled, bpm, seconds, onToggleUnits, renderEnum, onGestureStart, onGestureEnd, resetValue }: EditProps) {
  if (spec.type === 'bool') {
    return (
      <div className={'mp-parameter-edit ' + (variant === 'mini' ? 'npm' : 'param')}>
        <span className={variant === 'mini' ? 'pnm' : 'pl'} title={spec.help}>{spec.label}</span>
        <button className={'sw2' + (value ? ' on' : '')} role="switch" aria-checked={!!value} disabled={disabled} onClick={(e) => (e.stopPropagation(), onChange(!value))} title={spec.help} />
      </div>
    );
  }
  if (spec.type === 'enum') {
    const opts = spec.options ?? [];
    // One function colour for every option (DESIGN-SYSTEM.md: interactive is one hue, never a rainbow).
    
    // ≤6 options → a radial pick (the standard multi-choice); more → cycle (a list would be next).
    return (
      <div className={'mp-parameter-edit ' + (variant === 'mini' ? 'npm' : 'param')}>
        <span className={variant === 'mini' ? 'pnm' : 'pl'} title={spec.help}>{spec.label}</span>
        {opts.length <= 6 && !disabled && renderEnum ? (
          renderEnum({ spec, value: String(value), options: opts, onChange })
        ) : (
          <button className="enumbtn nodrag" disabled={disabled || !opts.length} onClick={(e) => (e.stopPropagation(), onChange(opts[(opts.indexOf(String(value)) + 1) % opts.length]))} title={`${spec.help ?? ''} — click to cycle`}>
            {String(value)} ▾
          </button>
        )}
      </div>
    );
  }

  const v = typeof value === 'number' ? value : Number(spec.default) || 0;
  // Typed drafts and active scrubs belong to this field, not to the inspector's reused row.
  // A node change discards the draft and runs useScrub's unmount cleanup before another field edits.
  return <Slider key={fieldKey} spec={spec} v={v} onChange={onChange} fieldKey={fieldKey} variant={variant} mod={mod} disabled={disabled} bpm={bpm} seconds={seconds} onToggleUnits={onToggleUnits} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} resetValue={resetValue} />;
}

function Slider({ spec, v, onChange, fieldKey, variant, mod, disabled, bpm, seconds, onToggleUnits, onGestureStart, onGestureEnd, resetValue }: Omit<EditProps, 'value' | 'mode'> & { v: number }) {
  const [typing, setTyping] = useState(false);
  const scrub = useScrub(spec, v, onChange, disabled, () => setTyping(true), { onGestureStart, onGestureEnd }, resetValue);
  const pc = fraction(spec, v) * 100;
  const shown = fmtValue(spec, v, bpm, seconds);
  const mus = spec.type === 'beats';
  const label = spec.label.toLowerCase();
  const family = /^(in|out|window|clip in|clip out|start|end)/.test(label) ? 'range' : /^(repeat|times|span|at|every|frames back|pause|laps|speed|rate|duration)/.test(label) ? 'time' : /^(amount|level|factor|density|smooth|radius|strength|mix|opacity)/.test(label) ? 'level' : undefined;
  const a11y = {
    role: 'slider',
    tabIndex: disabled ? -1 : 0,
    'aria-label': spec.label,
    'aria-valuetext': shown,
    'aria-valuenow': v,
    'aria-valuemin': spec.min,
    'aria-valuemax': spec.max,
    'aria-disabled': disabled,
    onKeyDown: scrub.onKeyDown,
    onDoubleClick: scrub.onDoubleClick,
    onContextMenu: scrub.onContextMenu,
  } as const;
  const tip = disabled ? 'Locked: this node predates the current definition' : 'Click to type a value · drag ↔ to scrub (Shift fine, Alt coarse) · right-click resets';
  const typeIn = (cls: string) => <TypeIn spec={spec} v={v} bpm={bpm} seconds={seconds} onChange={onChange} onDone={() => setTyping(false)} className={cls} />;
  const modTag = mod && <span className="modtag" title={`Modulated by ${mod}`}>~{variant === 'mini' ? mod.replace(/\D/g, '') : ' ' + mod}</span>;
  const toggle = mus && (
    <span className="utog nodrag" role="button" title="Toggle musical / seconds for this field" onClick={(e) => (e.stopPropagation(), onToggleUnits?.())}>
      {seconds ? 's' : '♪'}
    </span>
  );

  if (variant === 'mini') {
    return (
      <div className={'mp-parameter-edit npm nodrag scrub-field-mini' + (mod ? ' modlinked' : '') + (disabled ? ' locked' : '')} data-family={family} title={disabled ? tip : undefined}>
        <span className="pnm" title={spec.help ? `${spec.label} — ${spec.help}` : spec.label}>{spec.label}</span>
        <div className="nslider" {...a11y} onPointerDown={(e) => scrub.onPointerDown(e, true)}>
          <div className="nfill" style={{ width: pc + '%' }} />
          <div className="nknob" style={{ left: pc + '%' }} />
        </div>
        {typing ? typeIn('pval') : (
          <span className={'pval' + (mus ? ' musval' : '')} title={tip} onPointerDown={(e) => scrub.onPointerDown(e, false)} onContextMenu={scrub.onContextMenu}>
            {shown}
          </span>
        )}
        {modTag}
      </div>
    );
  }
  return (
    <div className={'mp-parameter-edit param scrub-field' + (mod ? ' modlinked' : '') + (disabled ? ' locked' : '')} data-family={family} title={disabled ? tip : undefined}>
      <div className="pl">
        <span>
          {spec.label}
          {spec.help && <span className="help" title={spec.help}>i</span>}
          {modTag}
        </span>
        <span>
          {typing ? typeIn('pv') : (
            <span className={'pv scrubnum' + (mus ? ' musval' : '')} title={tip} onPointerDown={(e) => scrub.onPointerDown(e, false)} onContextMenu={scrub.onContextMenu}>
              {shown}
            </span>
          )}
          {toggle}
        </span>
      </div>
      <div className="rng" {...a11y} onPointerDown={(e) => scrub.onPointerDown(e, true)}>
        <div className="fill" style={{ width: pc + '%' }} />
        <div className="knob" style={{ left: pc + '%' }} />
      </div>
    </div>
  );
}
