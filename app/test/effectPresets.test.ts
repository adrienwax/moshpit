import { describe, expect, it } from 'vitest';
import { DEF_BY_KIND } from '@moshpit/engine';
import { effectPresetValues, matchingEffectPreset, putEffectPreset, removeEffectPreset, sanitizeEffectPresets } from '../src/lib/effectPresets';

const def = DEF_BY_KIND.get('fx.posterize')!;

describe('app-scoped effect presets', () => {
  it('round-trips parameter values while excluding graph state and clamping invalid controls', () => {
    const params = effectPresetValues(def, { levels: 9.8, wet: 200, bogus: 'discard' });
    expect(params.levels).toBe(10); expect(params.wet).toBe(1); expect(params).not.toHaveProperty('bogus');
    const library = putEffectPreset({}, def, '  Rough   print ', params, 'id-1');
    expect(library[def.kind][0].name).toBe('Rough print');
    expect(sanitizeEffectPresets(JSON.parse(JSON.stringify(library)))).toEqual(library);
    expect(matchingEffectPreset(def, params, library[def.kind])?.id).toBe('id-1');
    expect(matchingEffectPreset(def, { ...params, levels: 3 }, library[def.kind])).toBeUndefined();
  });

  it('renames or updates by stable ID and never mutates the old library', () => {
    const first = putEffectPreset({}, def, 'One', { levels: 3 }, 'stable');
    const renamed = putEffectPreset(first, def, 'New name', { levels: 5 }, 'stable');
    expect(renamed[def.kind]).toHaveLength(1);
    expect(renamed[def.kind][0]).toMatchObject({ id: 'stable', name: 'New name', params: { levels: 5 } });
    expect(first[def.kind][0].name).toBe('One');
    expect(removeEffectPreset(renamed, def.kind, 'stable')).toEqual({});
  });

  it('rejects accidental name collisions, blank names and capacity overflow', () => {
    const first = putEffectPreset({}, def, 'Same', {}, 'a');
    expect(() => putEffectPreset(first, def, 'same', {}, 'b')).toThrow('already exists');
    expect(() => putEffectPreset(first, def, ' ', {}, 'b')).toThrow('name');
    const full = { [def.kind]: Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, name: `${i}`, params: {} })) };
    expect(() => putEffectPreset(full, def, 'Extra', {}, 'extra')).toThrow('50');
    expect(putEffectPreset(full, def, 'Renamed', {}, '0')[def.kind]).toHaveLength(50);
  });

  it('sanitizes malformed files without interpreting arrays or nested data as values', () => {
    expect(sanitizeEffectPresets(null)).toEqual({});
    const raw = { 'fx.posterize': [null, { id: 'a', name: 'Print', params: { levels: 5, bad: Infinity, array: [], nested: { x: 1 } } }, { id: 'b', name: 'print', params: {} }, { id: 'a', name: 'Duplicate id', params: {} }], '../path': [{ id: 'x', name: 'bad', params: {} }] };
    expect(sanitizeEffectPresets(raw)).toEqual({ 'fx.posterize': [{ id: 'a', name: 'Print', params: { levels: 5 } }] });
    expect(effectPresetValues(def, { levels: NaN }).levels).toBe(def.params.find(p => p.key === 'levels')!.initial ?? def.params.find(p => p.key === 'levels')!.default);
  });
});
