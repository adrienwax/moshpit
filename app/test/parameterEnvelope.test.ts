import { describe, expect, it } from 'vitest';
import type { ParamBinding } from '@moshpit/core';
import { compileExpr, evalExpr } from '../../engine/src/control/expr';
import { enableEnvelope, evaluateEnvelope, makeEnvelopeExpression, readEnvelope, removeEnvelope, updateEnvelope, type Envelope } from '../src/lib/parameterEnvelope';

const base: Envelope = { version: 1, start: 2, end: 6, from: 10, to: 90, ease: 'linear', hue: 'direct' };
function actual(envelope: Envelope, time: number): number {
  const expr = compileExpr(makeEnvelopeExpression(envelope));
  return evalExpr(expr, { vars: new Float64Array([0, 0, time * 60, time, 0, 60, 120]), lfo: () => 0, noise: () => 0 });
}
function parity(envelope: Envelope, times: number[]) {
  for (const time of times) expect(actual(envelope, time), `${envelope.ease}/${envelope.hue} at ${time}`).toBe(evaluateEnvelope(envelope, time));
}

describe('two-endpoint envelope expression parity', () => {
  it.each(['linear', 'in', 'out', 'smooth'] as const)('holds endpoints and follows %s easing through the actual evaluator', ease => {
    const envelope = { ...base, ease };
    parity(envelope, [-10, 0, 2, 2.000000000001, 3, 4, 5.999999999999, 6, 20]);
    expect(actual(envelope, 0)).toBe(10); expect(actual(envelope, 6)).toBe(90);
    expect(actual(envelope, 4)).toBe(ease === 'in' ? 30 : ease === 'out' ? 70 : 50);
  });

  it.each(['linear', 'in', 'out', 'smooth'] as const)('handles tiny durations and scientific literals with %s', ease => {
    const tiny = { ...base, start: 0, end: 1e-20, from: -1e-10, to: 2e-10, ease };
    parity(tiny, [-1e-20, 0, 2.5e-21, 5e-21, 9.999999999999999e-21, 1e-20, 2e-20]);
    const adjacent = { ...base, start: 1, end: 1 + Number.EPSILON, ease };
    parity(adjacent, [1 - Number.EPSILON, 1, 1 + Number.EPSILON, 2]);
    const subnormal = { ...base, start: 0, end: Number.MIN_VALUE, ease };
    parity(subnormal, [-Number.MIN_VALUE, 0, Number.MIN_VALUE, Number.MIN_VALUE * 2]);
  });

  it('allows finite caller-bounded scalars without hard-coded parameter limits or delta overflow', () => {
    const huge = { ...base, from: -Number.MAX_VALUE, to: Number.MAX_VALUE };
    parity(huge, [0, 2, 3, 4, 5, 6, 8]);
    expect(actual(huge, 4)).toBe(0);
    expect(actual({ ...base, from: -5000, to: 12000 }, 4)).toBe(3500);
  });

  it('keeps direct hue interpolation distinct from the shortest wrapped route', () => {
    const direct = { ...base, from: 170, to: -170 };
    const shortest = { ...direct, hue: 'shortest' as const };
    expect(actual(direct, 4)).toBe(0);
    expect(actual(shortest, 4)).toBe(-180);
    expect(actual(shortest, 3)).toBe(175);
    expect(actual(shortest, 5)).toBe(-175);
    parity(shortest, [-1, 2, 3, 4, 5, 6, 8]);
  });

  it.each([
    [0, 180, -90], [0, -180, -90], [180, 0, 90], [-180, 0, 90],
    [-170, 170, -180], [-550, 550, -180], [720 + 10, -720 + 30, 20],
    [-540, 540, -180],
  ])('handles wrapped endpoints %s→%s with a deterministic tie', (from, to, midpoint) => {
    const envelope = { ...base, from, to, hue: 'shortest' as const };
    parity(envelope, [-1, 2, 3, 4, 5, 6, 8]);
    expect(actual(envelope, 4)).toBe(midpoint);
    for (const time of [0, 2, 3, 4, 5, 6, 10]) {
      expect(actual(envelope, time)).toBeGreaterThanOrEqual(-180);
      expect(actual(envelope, time)).toBeLessThan(180);
    }
  });

  it('keeps boundary angles and long scientific constants parseable below 512 characters', () => {
    for (const ease of ['linear', 'in', 'out', 'smooth'] as const) for (const hue of ['direct', 'shortest'] as const) {
      const envelope = { ...base, start: 1.1234567891234567e100, end: 1.1234567891234568e100, from: -1.7976931348623157e308, to: 1.7976931348623157e308, ease, hue };
      const source = makeEnvelopeExpression(envelope);
      expect(source.length).toBeLessThanOrEqual(512); expect(() => compileExpr(source)).not.toThrow();
      parity(envelope, [0, envelope.start, envelope.end, Number.MAX_VALUE]);
      const edge = { ...base, from: 179.99999999999997, to: -179.99999999999997, ease, hue };
      parity(edge, [1.9999999999999998, 2, 4, 6, 6.000000000000001]);
    }
  });

  it.each([
    { start: -1 }, { end: 2 }, { end: 1 }, { start: NaN }, { end: Infinity }, { from: -Infinity }, { to: NaN },
    { version: 2 }, { ease: 'spline' }, { hue: 'round' }, { from: '10' },
  ])('rejects malformed envelope %j', patch => {
    const envelope = { ...base, ...patch } as Envelope;
    expect(() => makeEnvelopeExpression(envelope)).toThrow();
    expect(() => evaluateEnvelope(envelope, 0)).toThrow();
    expect(() => enableEnvelope(undefined, envelope)).toThrow();
  });
});

describe('envelope binding provenance and preservation', () => {
  it('preserves manual/opaque fields, LFO and Value while restoring the exact original expression once', () => {
    const original = {
      expression: { source: 'base+lfo(1)', op: 'add', plugin: { private: [1, 2, 3] } },
      lfo: { lfoId: 'lfo', depth: 0.5, op: 'multiply' },
      value: { valueId: 'v', from: 0, to: 1, curve: 'linear' },
      base: 0.7, opaque: { future: true },
    } as ParamBinding;
    const snapshot = JSON.stringify(original);
    const enabled = enableEnvelope(original, base);
    expect(readEnvelope(enabled)).toEqual(base);
    expect(enabled.expression?.op).toBe('replace');
    expect(enabled.lfo).toBe(original.lfo); expect(enabled.value).toBe(original.value); expect(enabled.opaque).toBe(original.opaque);
    const updated = updateEnvelope(enabled, { ...base, to: 77 })!;
    const reenabled = enableEnvelope(updated, { ...base, to: 66 });
    const removed = removeEnvelope(reenabled)!;
    expect(removed).toEqual(original); expect(removed.expression).toBe(original.expression);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(readEnvelope(removed)).toBeNull();
    // Persistence must retain backup semantics and opaque expression fields.
    expect(removeEnvelope(JSON.parse(JSON.stringify(reenabled)))).toEqual(original);
  });

  it('restores absence separately from an explicitly undefined expression, including JSON round trips', () => {
    for (const original of [{ opaque: 1 }, { expression: undefined, opaque: 2 }] satisfies ParamBinding[]) {
      const enabled = enableEnvelope(original, base);
      const removed = removeEnvelope(JSON.parse(JSON.stringify(enabled)))!;
      expect(removed).toEqual(original);
      expect(Object.hasOwn(removed, 'expression')).toBe(Object.hasOwn(original, 'expression'));
    }
    expect(removeEnvelope(enableEnvelope(undefined, base))).toEqual({});
  });

  it('keeps current LFO/value edits made while the envelope was active', () => {
    const enabled = enableEnvelope({ expression: { source: '42', op: 'multiply' } }, base);
    const current = { ...enabled, opaque: 'new', lfo: { lfoId: 'new', depth: 1, op: 'add' } } as ParamBinding;
    const removed = removeEnvelope(current)!;
    expect(removed.lfo).toBe(current.lfo); expect(removed.opaque).toBe('new');
    expect(removed.expression).toEqual({ source: '42', op: 'multiply' });
  });

  it('refuses automatic updates/removal after custom expression edits, but explicit enable records the new original', () => {
    const enabled = enableEnvelope({ expression: { source: 'base', op: 'add' } }, base);
    const external = { ...enabled, expression: { source: 'time*8', op: 'multiply' as const, custom: true } };
    expect(readEnvelope(external)).toBeNull();
    expect(updateEnvelope(external, { ...base, to: 2 })).toBe(external);
    expect(removeEnvelope(external)).toBe(external);
    const explicit = enableEnvelope(external, base);
    expect(removeEnvelope(explicit)?.expression).toBe(external.expression);
    const changedOp = { ...enabled, expression: { ...enabled.expression!, op: 'add' as const } };
    expect(readEnvelope(changedOp)).toBeNull(); expect(removeEnvelope(changedOp)).toBe(changedOp);
  });

  it.each([null, [], {}, { envelope: base }, { envelope: base, backup: {} },
    { envelope: { ...base, version: 9 }, backup: { present: false } },
    { envelope: base, backup: { present: true } },
    { envelope: base, backup: { present: true, expression: { source: 'x', op: 'bad' } } },
    { envelope: base, backup: { present: false, expression: { source: 'x', op: 'replace' } } },
  ])('does not recognize or replace malformed metadata %j', parameterEnvelope => {
    const binding = { expression: { source: makeEnvelopeExpression(base), op: 'replace' as const }, parameterEnvelope };
    expect(readEnvelope(binding)).toBeNull(); expect(removeEnvelope(binding)).toBe(binding);
    expect(updateEnvelope(binding, base)).toBe(binding);
  });

  it('preserves opaque metadata on update and returns an independent envelope value', () => {
    const enabled = enableEnvelope(undefined, base);
    (enabled.parameterEnvelope as Record<string, unknown>).futureEditor = { revision: 7 };
    const read = readEnvelope(enabled)!; read.from = 999;
    expect(readEnvelope(enabled)?.from).toBe(base.from);
    const updated = updateEnvelope(enabled, { ...base, ease: 'smooth' })!;
    expect((updated.parameterEnvelope as Record<string, unknown>).futureEditor).toEqual({ revision: 7 });
  });

  it('does not recognize inherited metadata fields or an inherited expression operator', () => {
    const inherited = Object.create(base) as Envelope;
    expect(() => makeEnvelopeExpression(inherited)).toThrow();
    const enabled = enableEnvelope(undefined, base);
    const opaque = { ...enabled, parameterEnvelope: Object.create(enabled.parameterEnvelope as object) };
    expect(readEnvelope(opaque)).toBeNull(); expect(removeEnvelope(opaque)).toBe(opaque);
    const inheritedOp = { ...enabled, expression: Object.assign(Object.create({ op: 'replace' }), { source: enabled.expression!.source }) };
    expect(readEnvelope(inheritedOp)).toBeNull();
  });
});
