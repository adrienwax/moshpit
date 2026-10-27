import { describe, expect, it } from 'vitest';
import { applyControlWrite, type AdjustMode } from '../src/control/params';
import type { ParamDef, ParamKey, ParamValue } from '@moshpit/core';

const context = { target: '/test/value', generation: 1 };
const integer: ParamDef = { key: 'frames' as ParamKey, label: 'Frames', help: 'Test frame count', type: 'int', default: 20, min: 0, max: 1000, step: 1 };
const floating: ParamDef = { ...integer, type: 'float', step: 2 };
const options: ParamDef = { key: 'kind' as ParamKey, label: 'Kind', help: 'Test option list', type: 'enum', default: 'a', options: ['a','b','c','d','e','f','g'] };
const write = (def: ParamDef, current: ParamValue, delta: number, mode: AdjustMode = 'normal') => applyControlWrite(context, def, current, { ...context, delta, mode, source: 'ct' });

describe('usable held rotary modes for discrete parameters', () => {
  it('moves a step-one integer in both directions by at least one unit in fine mode', () => {
    expect(write(integer, 20, 1, 'fine')).toBe(21);
    expect(write(integer, 20, -1, 'fine')).toBe(19);
    expect(write(integer, 20, 4, 'fine')).toBe(24);
    expect(write(integer, 20, 0, 'fine')).toBe(20);
  });
  it('keeps coalesced and individual integer detents equal for larger declared steps', () => {
    const def = { ...integer, step: 15 };
    expect(write(def, 20, 1, 'fine')).toBe(22);
    expect(write(def, write(def, write(def, 20, 1, 'fine'), 1, 'fine'), 1, 'fine')).toBe(write(def, 20, 3, 'fine'));
    expect(write(integer, 20, 2, 'coarse')).toBe(40);
    expect(write(integer, 1, -3, 'fine')).toBe(0);
    expect(write(integer, 999, 3, 'fine')).toBe(1000);
  });
  it('preserves continuous 0.1x fine and 10x fast changes', () => {
    expect(write(floating, 20, 1, 'fine')).toBe(20.2);
    expect(write(floating, 20, -2, 'fine')).toBe(19.6);
    expect(write(floating, 20, 2, 'coarse')).toBe(60);
  });
  it('steps enums one option in fine and up to five in fast, preserving reversals', () => {
    expect(write(options, 'a', 1, 'fine')).toBe('b');
    expect(write(options, 'a', -1, 'fine')).toBe('g');
    expect(write(options, 'a', 1, 'coarse')).toBe('f');
    expect(write(options, 'a', -1, 'coarse')).toBe('c');
    expect(write({ ...options, options: ['a','b','c','d','e'] }, 'a', 1, 'coarse')).toBe('e');
    expect(write({ ...options, options: ['a','b'] }, 'a', 1, 'coarse')).toBe('b');
  });
  it('never scales absolute values or repeats boolean actions', () => {
    expect(applyControlWrite(context, integer, 20, { ...context, value: 47, mode: 'fine', source: 'ct' })).toBe(47);
    expect(applyControlWrite(context, options, 'a', { ...context, value: 'c', mode: 'coarse', source: 'ct' })).toBe('c');
    expect(write({ key: 'on' as ParamKey, label: 'On', help: 'Test toggle', type: 'bool', default: false }, false, 10, 'coarse')).toBe(true);
  });
  it('continues rejecting stale writes and refuses non-finite enum deltas', () => {
    expect(() => applyControlWrite(context, integer, 20, { ...context, generation: 0, delta: 1, mode: 'fine', source: 'ct' })).toThrow(/CONTROL_STALE_TARGET/);
    expect(() => write(options, 'a', NaN, 'fine')).toThrow(/PARAM_OUT_OF_RANGE/);
  });
});
