import { describe, expect, it } from 'vitest';
import { parseExamples } from '../src/lib/exampleProjects';
const row = { id: 'texture-carry', title: 'Texture carry', group: 'pixelord', file: 'E:/examples/demo.mosh', preview: 'E:/examples/demo.mp4', seconds: 12, hint: 'Try changing the cut' };
describe('local example index', () => {
  it('is optional and accepts local paths with spaces', () => {
    expect(parseExamples(null)).toEqual([]);
    expect(parseExamples({schemaVersion: 1, examples: [{...row, file: 'E:/my examples/demo.mosh'}]})).toHaveLength(1);
  });
  it.each([{file: 'https://host/demo.mosh'}, {file: '../demo.mosh'}, {preview: 'https://host/demo.mp4'}, {seconds: NaN}, {group: 'unknown'}, {hint: 'x'.repeat(501)}])('rejects malformed entries %j', change => {
    expect(() => parseExamples({schemaVersion: 1, examples: [{...row,...change}]})).toThrow();
  });
  it('rejects duplicates and oversized lists', () => {
    expect(() => parseExamples({schemaVersion: 1, examples: [row,row]})).toThrow();
    expect(() => parseExamples({schemaVersion: 1, examples: Array(97).fill(row)})).toThrow();
  });
});
