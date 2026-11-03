import { describe, expect, it } from 'vitest';
import { exampleIndexWarning, filterExamples, parseExamples } from '../src/lib/exampleProjects';
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
    const many = Array.from({length:128}, (_,i)=>({...row,id:`example-${i}`}));
    expect(parseExamples({schemaVersion:1,examples:many})).toHaveLength(128);
    expect(() => parseExamples({schemaVersion: 1, examples: [...many,{...row,id:'over-limit'}]})).toThrow();
  });
});

describe('browse collection metadata', () => {
  it('keeps legacy local indexes and accepts unavailable bundled entries', () => {
    expect(parseExamples({schemaVersion: 1, examples: [row]})[0].collection).toBe('local');
    const [entry] = parseExamples({schemaVersion: 1, examples: [{...row, collection:'bundled', unavailable:'Project media is missing.'}]});
    expect(entry.collection).toBe('bundled');
    expect(entry.unavailable).toBe('Project media is missing.');
  });
  it.each([{collection:'remote'}, {unavailable:''}, {unavailable:42}, {unavailable:'x'.repeat(241)}])('rejects invalid collection state %j', change => {
    expect(() => parseExamples({schemaVersion:1, examples:[{...row,...change}]})).toThrow();
  });
  it('searches title and teaching hint with category, without exposing private paths', () => {
    const rows = parseExamples({schemaVersion:1,examples:[row, {...row,id:'echo',title:'Soft Echo',group:'mix',hint:'Try increasing delayed feedback'}]});
    expect(filterExamples(rows,' soft  FEEDBACK ', 'mix').map(x=>x.id)).toEqual(['echo']);
    expect(filterExamples(rows,'feedback', 'pixelord')).toEqual([]);
    expect(filterExamples(rows,'E:/examples','all')).toEqual([]);
    expect(filterExamples(rows,'','all')).toEqual(rows);
    expect(rows).toHaveLength(2);
  });
  it('keeps a bounded collection warning separate from usable entries', () => {
    const raw={schemaVersion:1,examples:[row],warning:'Some local examples are unavailable.'};
    expect(parseExamples(raw)).toHaveLength(1);
    expect(exampleIndexWarning(raw)).toBe(raw.warning);
    expect(exampleIndexWarning({warning:'x'.repeat(241)})).toBe('');
    expect(exampleIndexWarning(null)).toBe('');
  });
});
