// Phase 0.4: the path rules behind the read-only source guarantee (core/src/paths.ts).
import { describe, expect, it } from 'vitest';
import { isInside, overlaps, safeFileName, samePath } from '@moshpit/core';

describe('path rules', () => {
  it('compares Windows paths case- and slash-insensitively', () => {
    expect(samePath(String.raw`Y:\ExampleMedia\raw\a.mp4`, 'y:/examplemedia/RAW/a.mp4')).toBe(true);
    expect(samePath('', '')).toBe(false);
  });
  it('isInside needs a separator boundary, not a string prefix', () => {
    expect(isInside(String.raw`X:\example-media\.cache\engine`, String.raw`X:\example-media`)).toBe(true);
    expect(isInside(String.raw`X:\example-media-2\x`, String.raw`X:\example-media`)).toBe(false);
    expect(isInside(String.raw`X:\example-media\ `.trim(), String.raw`X:\example-media`)).toBe(true);
  });
  it('overlaps either way round', () => {
    expect(overlaps(String.raw`Y:\ExampleMedia`, String.raw`Y:\ExampleMedia\raw`)).toBe(true);
    expect(overlaps(String.raw`X:\example-media\.cache`, String.raw`Y:\ExampleMedia\raw`)).toBe(false); // separate drives do not overlap
  });
  it('safeFileName keeps a render name inside its folder', () => {
    expect(safeFileName(String.raw`..\..\Windows\evil`)).toBe('_.._Windows_evil');
    expect(safeFileName('a/b:c*?"<>|d')).toBe('a_b_c_d');
    expect(safeFileName('...')).toBe('render');
    expect(safeFileName('Mosh v2.final ')).toBe('Mosh v2.final');
  });
});
