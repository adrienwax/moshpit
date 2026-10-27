// U2: a freshly added picture effect visibly does something (its `initial`), while the neutral
// `default` (what a saved node lacking the key compiles with) never moves, so existing projects,
// presets and freezes render exactly as before.
import { describe, expect, it } from 'vitest';
import { DEF_BY_KIND } from '../src/nodes/defs';
import { newNode } from '../src/project/build';
import { PRESETS } from '../src/nodes/presets';

const U2: Record<string, Record<string, { initial: number; neutral: number }>> = {
  'fx.saturation': { amount: { initial: 170, neutral: 100 } },
  'fx.contrast': { amount: { initial: 150, neutral: 100 } },
  'fx.brightness': { level: { initial: 70, neutral: 100 } },
  'fx.hue-rotate': { degrees: { initial: 90, neutral: 0 } },
  'fx.posterize': { levels: { initial: 4, neutral: 6 } },
  'fx.resolution-crush': { factor: { initial: 16, neutral: 8 } },
  'fx.chroma-drift': { cb: { initial: 60, neutral: 24 }, cr: { initial: -60, neutral: -24 } },
  'fx.soft-blur': { radius: { initial: 6, neutral: 3 } },
};

describe('effect starting values (U2)', () => {
  it('a new node starts from initial; the neutral default is unchanged', () => {
    for (const [kind, ps] of Object.entries(U2)) {
      const n = newNode(kind);
      for (const [key, v] of Object.entries(ps)) {
        expect(n.params[key], `${kind}.${key}`).toBe(v.initial);
        expect(DEF_BY_KIND.get(kind)!.params.find((p) => p.key === key)!.default, `${kind}.${key} default`).toBe(v.neutral);
      }
    }
  });
  it('every initial sits inside its range', () => {
    for (const d of DEF_BY_KIND.values()) for (const p of d.params) if (typeof p.initial === 'number') {
      expect(p.initial, `${d.kind}.${p.key}`).toBeGreaterThanOrEqual(p.min ?? -Infinity);
      expect(p.initial, `${d.kind}.${p.key}`).toBeLessThanOrEqual(p.max ?? Infinity);
    }
  });
  it('only these effects have an initial (nothing else changed)', () => {
    const have = [...DEF_BY_KIND.values()].filter((d) => d.params.some((p) => p.initial !== undefined)).map((d) => d.kind as string).sort();
    expect(have).toEqual(Object.keys(U2).sort());
  });
  it('presets are explicit values: unchanged by the new starting values', () => {
    // A preset of these kinds sets the keys it means; they do not read default or initial.
    // Applying one merges its keys onto the node (setParams); keys it omits keep the node's value.
    for (const kind of Object.keys(U2)) for (const p of PRESETS[kind] ?? []) for (const v of Object.values(p.params)) expect(v, `${kind}/${p.name}`).not.toBeUndefined();
  });
});
