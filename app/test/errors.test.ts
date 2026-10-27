import { describe, expect, it } from 'vitest';
import { MoshpitError } from '@moshpit/engine';
import { asError } from '../src/qol/qol';

describe('asError', () => {
  it('rebuilds a catalogued error that crossed the worker MessagePort as JSON', () => {
    const wire = JSON.parse(JSON.stringify(new MoshpitError('EXPORT_EXISTS', { path: 'x.mov' }).toJSON()));
    const e = asError(wire);
    expect(e.code).toBe('EXPORT_EXISTS');
    expect(e.suggestedFix).toMatch(/never overwrites/);
    expect(e.context).toEqual({ path: 'x.mov' });
  });

  it('passes MoshpitError through and wraps anything else as INTERNAL', () => {
    const m = new MoshpitError('DECODE_FAILED');
    expect(asError(m)).toBe(m);
    expect(asError(new Error('boom')).code).toBe('INTERNAL');
    expect(asError({ code: 'NOT_A_CODE' }).code).toBe('INTERNAL');
    expect(asError('string').code).toBe('INTERNAL');
  });
});
