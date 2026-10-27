import { describe, expect, it, vi } from 'vitest';
import { newBlock, newProject } from '../../engine/src/project/build';
import type { SourceId } from '@moshpit/engine';
vi.mock('../src/engine', () => ({ engine: {} }));
vi.mock('../src/state/project', () => ({ activeBlock: () => undefined, useProject: vi.fn() }));
vi.mock('../src/state/ui', () => ({ useUi: vi.fn(), setUi: vi.fn() }));
vi.mock('../src/qol/qol', () => ({ asError: vi.fn() }));
import { scopeTargets } from '../src/shell/Scopes';
const doc = newProject('Scopes');
doc.timeline.blocks = [newBlock('picture', 'source' as SourceId, 0, 100)];
describe('scope frame selection', () => {
  it('uses the captured zoom, and updates the range after a zoom change', () => {
    const first = scopeTargets(doc, 'range', 0, { start: 0, len: 10, of: 100 });
    const next = scopeTargets(doc, 'range', 0, { start: 60, len: 10, of: 100 });
    expect(first.every(t => t.frame >= 0 && t.frame <= 12)).toBe(true);
    expect(next.every(t => t.frame >= 60 && t.frame <= 72)).toBe(true);
    expect(next).not.toEqual(first);
  });
  it('deduplicates requests on a one-frame timeline', () => {
    const tiny = newProject('Tiny');
    tiny.timeline.blocks = [newBlock('one', 'source' as SourceId, 0, 1)];
    expect(scopeTargets(tiny, 'range', 0, { start: 1000, len: 20, of: 2000 })).toEqual([{ kind: 'output', frame: 0 }]);
  });
  it('clamps the program frame and never requests empty timelines', () => {
    expect(scopeTargets(doc, 'full', 400)).toEqual([{ kind: 'output', frame: 99 }]);
    expect(scopeTargets(newProject('Empty'), 'range', 0)).toEqual([]);
  });
});
