import { describe, expect, it } from 'vitest';
import { PRESETS } from '@moshpit/engine';
import { nodeDefs } from '../src/engine';
import { entries } from '../src/lib/browse';
import { makeEffectDraft, presetDraft } from '../src/lib/effectDraft';
import { effectPresetValues } from '../src/lib/effectPresets';

describe('preserved Moshpit 1 starting points', () => {
  it('names the two whole-block adaptations without promising an unsupported tail window', () => {
    expect(PRESETS['fx.saturation'].find(p => p.name === 'Faded colour')?.params).toEqual({ amount: 20 });
    expect(PRESETS['fx.contrast'].find(p => p.name === 'Hard contrast')?.params).toEqual({ amount: 200 });
    expect(PRESETS['fx.saturation'].some(p => p.name === 'Fade the tail')).toBe(false);
    expect(PRESETS['fx.contrast'].some(p => p.name === 'Crush the tail')).toBe(false);
  });
  it('offers all 157 presets across their 31 catalogue operators with editable controls', () => {
    const defs = nodeDefs(), catalogue = entries(defs, []);
    expect(Object.keys(PRESETS)).toHaveLength(31);
    expect(Object.values(PRESETS).flat()).toHaveLength(157);
    for (const [kind, presets] of Object.entries(PRESETS)) {
      const entry = catalogue.find(e => e.id === kind);
      expect(entry, kind).toBeDefined();
      const def = defs.find(d => d.kind === kind)!;
      for (const preset of presets) {
        const draft = presetDraft(makeEffectDraft(entry!), preset.name);
        expect(draft.preset, `${kind}: ${preset.name}`).toBe(preset.name);
        const inspector = effectPresetValues(def, preset.params);
        for (const [key, value] of Object.entries(preset.params)) {
          expect(def.params.some(p => p.key === key), `${kind}.${key}`).toBe(true);
          expect(draft.controls.some(c => c.key === key), `${kind}.${key} editable`).toBe(true);
          expect(draft.params[0]?.[key], `${kind}: ${preset.name}.${key} quick tune`).toEqual(value);
          expect(inspector[key], `${kind}: ${preset.name}.${key} inspector`).toEqual(value);
        }
      }
    }
  });
});
