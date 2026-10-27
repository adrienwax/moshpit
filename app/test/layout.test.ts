import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUTS, LIMITS, dropPane, migrateBrowseLayout, sanitize, untab, type WsLayout } from '../src/layout/model';

const panesOf = (cols: ReturnType<typeof sanitize>) => cols.map((c) => c.stacks.map((s) => s.panes.join('+')));

// Compose, UX round 2 grid: dock [slots+clips+library] · main [program, graph] · inspect [block] · band [effects, edit, render].
describe('layout model', () => {
  // Retain legacy layout fixtures: saved owner layouts still support the same docking operations.
  const stack = (panes: string[]) => ({ id: 's-' + panes[0], panes, active: 0, f: 1 });
  const mosh: WsLayout = [
    { id: 'dock', w: 340, stacks: [stack(['slots']), stack(['clips', 'library'])] },
    { id: 'main', stacks: [stack(['program']), stack(['graph'])] },
    { id: 'inspect', w: 420, stacks: [stack(['block'])] },
    { id: 'bottom', band: true, h: .22, stacks: [stack(['effects']), stack(['edit']), stack(['render'])] },
  ];
  it('keeps source, edit and export previews in the flexible centre with distinct left and right roles', () => {
    for (const [ws, pane] of [['browse','bigpv'], ['mosh','program'], ['render','preview']] as const) {
      const cols = DEFAULT_LAYOUTS[ws];
      expect(cols.find(c => c.w === undefined)?.stacks.flatMap(s => s.panes)).toContain(pane);
      expect(cols).toHaveLength(3);
    }
    expect(DEFAULT_LAYOUTS.browse[0].stacks.flatMap(s => s.panes)).toEqual(['places','browser']);
    expect(DEFAULT_LAYOUTS.mosh[1].stacks.map(s => s.panes)).toEqual([['program'],['edit'],['detail','graph','block','render']]);
    expect(DEFAULT_LAYOUTS.mosh[2].stacks.map(s => s.panes)).toEqual([['effects']]);
    expect(DEFAULT_LAYOUTS.mosh[1].stacks[2].collapsed).toBe(true);
    // Existing views remain available, even when no longer all open at once.
    const current = DEFAULT_LAYOUTS.mosh.flatMap(c => c.stacks.flatMap(s => s.panes)).sort();
    expect(current).toEqual([...mosh.flatMap(c => c.stacks.flatMap(s => s.panes)), 'detail'].sort());
  });

  it('migrates the old IN column into Places and a full-height browser without resetting preview sizes', () => {
    const old: WsLayout = [
      { id: 'browser', w: 400, stacks: ['places', 'tree', 'grid'].map(p => ({ id: p, panes: [p], active: 0 })) },
      { id: 'main', stacks: [{ id: 'preview', panes: ['bigpv'], active: 0 }] },
      { id: 'clip', w: 270, stacks: [{ id: 'info', panes: ['meta', 'convert'], active: 1 }] },
    ];
    const before = structuredClone(old);
    const out = migrateBrowseLayout(old);
    expect(panesOf(out)).toEqual([['places'], ['browser'], ['bigpv'], ['meta+convert']]);
    expect(out[1].w).toBe(400);
    expect(out[3]).toEqual(old[2]);
    expect(old).toEqual(before);
    expect(migrateBrowseLayout(out)).toBe(out);
  });

  it('retains separately docked Places and collapses folder/clip tabs to one browser', () => {
    const old: WsLayout = [
      { id: 'mine', w: 180, stacks: [{ id: 'p', panes: ['places'], active: 0 }] },
      { id: 'main', stacks: [{ id: 'g', panes: ['bigpv', 'tree', 'grid'], active: 2 }] },
    ];
    const out = sanitize(old, 'browse', ['places', 'browser', 'bigpv']);
    expect(panesOf(out)).toEqual([['places'], ['bigpv+browser']]);
    expect(out[1].stacks[0].active).toBe(1);
    expect(out[0].id).toBe('mine');
  });

  it('preserves saved MOSH sizes and active tabs when all existing panes remain available', () => {
    const custom = structuredClone(mosh); custom[0].w = 410; custom[0].stacks[1].active = 1;
    const before = structuredClone(custom);
    const known = custom.flatMap(c => c.stacks.flatMap(s => s.panes));
    expect(sanitize(custom, 'mosh', known)).toEqual(before);
    expect(custom).toEqual(before);
  });

  it('Compose default: the 3-band grid; Effects · Arrangement · Render share the bottom band; no retired panes', () => {
    expect(panesOf(mosh)).toEqual([['slots', 'clips+library'], ['program', 'graph'], ['block'], ['effects', 'edit', 'render']]);
    expect(mosh.find((c) => c.band)?.stacks.map((s) => s.panes[0])).toEqual(['effects', 'edit', 'render']);
    const all = mosh.flatMap((c) => c.stacks.flatMap((s) => s.panes));
    for (const gone of ['audio', 'slice', 'preview', 'strip', 'history', 'viewer', 'nodeview', 'inspector']) expect(all).not.toContain(gone);
  });

  it('tabs a pane into another stack and drops the emptied stack', () => {
    const next = dropPane(mosh, 'graph', { col: 'inspect', mode: 'tab', stack: 's-block' });
    expect(panesOf(next)[2]).toEqual(['block+graph']);
    expect(panesOf(next)[1]).toEqual(['program']);
    expect(next[2].stacks[0].active).toBe(1);
  });

  it('moves a pane across columns before a given stack, and untabs back', () => {
    const moved = dropPane(mosh, 'block', { col: 'dock', mode: 'before', stack: 's-slots' });
    expect(panesOf(moved)[0]).toEqual(['block', 'slots', 'clips+library']);
    expect(panesOf(untab(moved, 's-clips'))[0]).toEqual(['block', 'slots', 'clips', 'library']);
  });

  it('dropping a pane onto its own stack is a no-op', () => {
    expect(dropPane(mosh, 'clips', { col: 'dock', mode: 'tab', stack: 's-clips' })).toBe(mosh);
  });

  it('sanitize drops unknown panes and restores missing ones to their default column', () => {
    const stored = [{ id: 'dock', w: 200, stacks: [{ id: 'x', panes: ['clips', 'gone'], active: 1 }] }, { id: 'inspect', w: 300, stacks: [] }];
    const known = ['clips', 'slots', 'block'];
    const out = sanitize(stored, 'mosh', known);
    expect(panesOf(out)).toEqual([['clips', 'slots'], ['block']]);
    expect(out[0].stacks[0].active).toBe(0);
    expect(out.some((c) => c.w === undefined)).toBe(true);
  });

  it('every default has one flexible column; widths stay inside the resize bounds', () => {
    for (const cols of Object.values(DEFAULT_LAYOUTS)) {
      expect(cols.filter((c) => !c.band && c.w === undefined)).toHaveLength(1);
      for (const c of cols) if (c.w !== undefined) expect(c.w).toBeLessThanOrEqual(LIMITS.colMax);
    }
  });

  it('a pane dragged out of a band lands in a column; the emptied band goes', () => {
    // The bottom band holding only the arrangement: dragging it into the main column empties the band.
    const onlyEdit: WsLayout = mosh.map((c) => (c.band ? { ...c, stacks: c.stacks.filter((s) => s.panes.includes('edit')) } : c));
    const moved = dropPane(onlyEdit, 'edit', { col: 'main', mode: 'before' });
    const out = sanitize(moved, 'mosh', ['slots', 'clips', 'library', 'program', 'graph', 'block', 'edit']);
    expect(out.some((c) => c.band)).toBe(false);
    expect(panesOf(out)[1]).toEqual(['program', 'graph', 'edit']);
  });
});
