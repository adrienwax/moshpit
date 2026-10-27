import type { ParamBinding } from '@moshpit/core';

/** Absolute project seconds. The caller applies parameter bounds and exposes hue only for hue controls. */
export interface Envelope {
  version: 1;
  start: number;
  end: number;
  from: number;
  to: number;
  ease: 'linear' | 'in' | 'out' | 'smooth';
  hue: 'direct' | 'shortest';
}

type Expression = NonNullable<ParamBinding['expression']>;
type Backup = { present: false } | { present: true; expression: Expression } | { present: true; undefined: true };
interface Metadata { envelope: Envelope; backup: Backup; [opaque: string]: unknown }
const KEY = 'parameterEnvelope';
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function valid(value: unknown): value is Envelope {
  return record(value) && ['version', 'start', 'end', 'from', 'to', 'ease', 'hue'].every(key => own(value, key))
    && value.version === 1 && finite(value.start) && value.start >= 0 && finite(value.end) && value.end > value.start
    && finite(value.from) && finite(value.to) && ['linear', 'in', 'out', 'smooth'].includes(value.ease as string)
    && (value.hue === 'direct' || value.hue === 'shortest');
}
function checked(envelope: Envelope): Envelope {
  if (!valid(envelope)) throw new RangeError('An envelope needs finite values and an end after its non-negative start.');
  return envelope;
}
function expression(value: unknown): value is Expression {
  return record(value) && own(value, 'source') && own(value, 'op') && typeof value.source === 'string' && ['replace', 'add', 'multiply'].includes(value.op as string);
}
function backup(value: unknown): value is Backup {
  return record(value) && own(value, 'present') && (value.present === false && !own(value, 'expression') && !own(value, 'undefined')
    || value.present === true && (value.undefined === true && !own(value, 'expression')
      || !own(value, 'undefined') && own(value, 'expression') && expression(value.expression)));
}
/** Avoid adding 180 before reducing: that rounds near-boundary angles onto the other endpoint. */
function wrap(value: number): number {
  const angle = value % 360;
  return angle >= 180 ? angle - 360 : angle < -180 ? angle + 360 : angle;
}
function ends(envelope: Envelope): [number, number] {
  if (envelope.hue === 'direct') return [envelope.from, envelope.to];
  const from = wrap(envelope.from), to = wrap(envelope.to);
  return [from, from + wrap(to - from)]; // A 180-degree tie always travels in the negative direction.
}
function progress(envelope: Envelope, time: number): number {
  const x = Math.max(0, Math.min(1, (time - envelope.start) / (envelope.end - envelope.start)));
  return envelope.ease === 'in' ? x * x : envelope.ease === 'out' ? 1 - (1 - x) ** 2 : envelope.ease === 'smooth' ? x * x * (3 - 2 * x) : x;
}

/** Same arithmetic and endpoint branches as the engine formula; suitable for the editor's curve. */
export function evaluateEnvelope(envelope: Envelope, time: number): number {
  checked(envelope);
  if (!finite(time)) throw new RangeError('Envelope time must be finite.');
  const [from, to] = ends(envelope);
  const x = progress(envelope, time);
  const value = time <= envelope.start ? from : time >= envelope.end ? to : from * (1 - x) + to * x;
  // Match the expression evaluator's mathematical modulo, including its floating-point rounding.
  return envelope.hue === 'shortest' ? (value + 180) - 360 * Math.floor((value + 180) / 360) - 180 : value;
}

/** No LFO/value names or arbitrary code; fits the existing locked expression parser's 512-character limit. */
export function makeEnvelopeExpression(envelope: Envelope): string {
  checked(envelope);
  const [from, to] = ends(envelope), start = String(envelope.start), end = String(envelope.end);
  const x = `clamp((time-${start})/${envelope.end - envelope.start},0,1)`;
  const p = envelope.ease === 'in' ? `(${x})^2` : envelope.ease === 'out' ? `(1-(1-${x})^2)`
    : envelope.ease === 'smooth' ? `smoothstep(${start},${end},time)` : x;
  // Convex interpolation avoids overflowing to-from for finite, opposite-sign endpoints.
  const value = `(time<=${start}?${from}:time>=${end}?${to}:(${from})*(1-${p})+(${to})*${p})`;
  const source = envelope.hue === 'shortest' ? `mod(${value}+180,360)-180` : value;
  if (source.length > 512) throw new RangeError('Envelope expression exceeds the engine limit.');
  return source;
}

function metadata(binding: ParamBinding | undefined): Metadata | null {
  const value = binding?.[KEY];
  if (!record(value) || !own(value, 'envelope') || !own(value, 'backup') || !valid(value.envelope) || !backup(value.backup)) return null;
  if (!expression(binding?.expression) || binding.expression.op !== 'replace') return null;
  try {
    if (binding.expression.source !== makeEnvelopeExpression(value.envelope)) return null;
  } catch { return null; }
  return value as unknown as Metadata;
}

/** Recognition requires both valid metadata and the exact generated source/operator. */
export function readEnvelope(binding: ParamBinding | undefined): Envelope | null {
  const found = metadata(binding);
  return found ? { ...found.envelope } : null;
}

/** Explicit activation only. Existing valid envelopes keep their original backup across every update. */
export function enableEnvelope(binding: ParamBinding | undefined, envelope: Envelope): ParamBinding {
  const source = makeEnvelopeExpression(envelope), previous = metadata(binding);
  let original: Backup;
  if (previous) original = previous.backup;
  else if (!binding || !own(binding, 'expression')) original = { present: false };
  else if (binding.expression === undefined) original = { present: true, undefined: true };
  else {
    if (!expression(binding.expression)) throw new TypeError('Cannot back up a malformed expression binding.');
    original = { present: true, expression: binding.expression };
  }
  return {
    ...binding,
    expression: { ...binding?.expression, source, op: 'replace' },
    [KEY]: { ...(record(binding?.[KEY]) ? binding[KEY] : {}), envelope: { ...envelope }, backup: original },
  };
}

/** Stale/malformed metadata never authorizes replacing an independently edited expression. */
export function updateEnvelope(binding: ParamBinding | undefined, envelope: Envelope): ParamBinding | undefined {
  return metadata(binding) ? enableEnvelope(binding, envelope) : binding;
}

/** Restore the original expression exactly, retaining current LFO/value links and opaque binding fields. */
export function removeEnvelope(binding: ParamBinding | undefined): ParamBinding | undefined {
  const found = metadata(binding);
  if (!found || !binding) return binding;
  const next = { ...binding };
  delete next[KEY];
  if (!found.backup.present) delete next.expression;
  else if ('undefined' in found.backup) next.expression = undefined;
  else next.expression = found.backup.expression;
  return next;
}
