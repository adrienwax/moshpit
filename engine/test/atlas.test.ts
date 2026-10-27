// Phase 2.1 + 2.4: every placeable node has a look and a five-part explanation, and nothing else does.
import { describe, expect, it } from 'vitest';
import { ATLAS, LOOKS } from '../src/nodes/atlas';
import { PLACEABLE, DEF_BY_KIND } from '../src/nodes/defs';

describe('effect atlas', () => {
  it('covers every placeable kind, and only those', () => {
    const placeable = PLACEABLE.map((d) => d.kind as string).sort();
    expect(Object.keys(ATLAS).sort()).toEqual(placeable);
  });
  it('files each entry under a real look, with all five parts written', () => {
    for (const [kind, e] of Object.entries(ATLAS)) {
      expect(DEF_BY_KIND.has(kind), kind).toBe(true);
      expect(e.looks.length, kind).toBeGreaterThan(0);
      for (const l of e.looks) expect((LOOKS[l.cat] as readonly string[]).includes(l.sub), `${kind} ${l.cat}/${l.sub}`).toBe(true);
      for (const [part, text] of Object.entries(e.explain)) expect(text.length, `${kind}.${part}`).toBeGreaterThan(15);
    }
  });
  it('every look subcategory holds at least one entry', () => {
    const used = new Set(Object.values(ATLAS).flatMap((e) => e.looks.map((l) => `${l.cat}/${l.sub}`)));
    for (const [cat, subs] of Object.entries(LOOKS)) for (const sub of subs) expect(used.has(`${cat}/${sub}`), `${cat}/${sub}`).toBe(true);
  });
});
