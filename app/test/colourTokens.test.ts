import { describe, expect, it } from 'vitest';
// The design-system lint (A0.5) runs with the suite, so a new colour literal fails the tests too.
import { check, isRedFamily } from '../../scripts/check-colour-tokens.mjs';

describe('colour tokens', () => {
  it('keeps colour literals in shared/ui/tokens.css and crimson for caution only', () => {
    expect(check().errors).toEqual([]);
  });
  it('tells the red family from Moshpit coral and the category hues', () => {
    for (const red of ['#ff2e55', '#ff5d52', '#ee9380', 'rgba(232, 120, 90, .4)', 'hsl(0, 80%, 50%)']) expect(isRedFamily(red), red).toBe(true);
    for (const other of ['#f08a63', '#58cbbb', '#3fe0f2', '#c5d468', '#e5a2cc', '#d9609a', '#828d9f']) expect(isRedFamily(other), other).toBe(false);
  });
});
