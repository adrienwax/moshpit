// P2s (independent audit): a measured 0 on the render bar stripes instead of showing an empty
// segment; a layout version bump keeps NAMED saved layouts and says so.
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const stored: { v: unknown } = { v: null };
vi.mock('../src/host', () => ({ host: { readConfig: async () => stored.v, writeConfig: async () => {} } }));
const { StageBar } = await import('../src/ws/render/RenderPanes');
const { loadLayouts, layoutStore, LAYOUT_VERSION } = await import('../src/layout/model');

const job = (p: object) => ({ id: 'j', name: 'j', config: {}, outPath: 'x', status: 'rendering', fraction: 0, log: [], ...p }) as never;
const cur = (html: string) => /class="stg cur( indet)?"/.exec(html)?.[0];

describe('StageBar', () => {
  it('conform at exactly 0 is indeterminate (stripes), not an empty bar', () => {
    const html = renderToStaticMarkup(createElement(StageBar, { job: job({ conform: { fraction: 0, clips: 1 } }) }));
    expect(cur(html)).toBe('class="stg cur indet"');
    expect(html).not.toContain('width:0%');
  });
  it('a measured conform fraction still fills', () => {
    const html = renderToStaticMarkup(createElement(StageBar, { job: job({ conform: { fraction: 0.5, clips: 1 } }) }));
    expect(cur(html)).toBe('class="stg cur"');
    expect(html).toContain('width:50%');
  });
});

describe('loadLayouts across a version bump', () => {
  const saved = [{ name: 'mine', ws: 'mosh', layout: [] }];
  it('keeps named saved layouts when a pre-v7 layout requires a reset, and returns a notice', async () => {
    stored.v = { v: 6, current: { mosh: [] }, saved };
    const notice = await loadLayouts();
    expect(layoutStore.get().saved).toEqual(saved);
    expect(layoutStore.get().current).toEqual({});
    expect(notice).toMatch(/1 saved layout was kept/);
  });
  it('migrates v7 IN without resetting other custom workspaces or changing the named originals', async () => {
    const mosh = [{ id: 'custom', w: 420, stacks: [{ id: 'mine', panes: ['graph'], active: 0 }] }];
    const browse = [{ id: 'browser', w: 370, stacks: ['places', 'tree', 'grid'].map(p => ({ id: p, panes: [p], active: 0 })) }];
    const named = [{ name: 'Old IN', ws: 'browse', layout: browse }];
    stored.v = { v: 7, current: { mosh, browse }, saved: named };
    expect(await loadLayouts()).toBeUndefined();
    expect(layoutStore.get().current.mosh).toEqual(mosh);
    expect(layoutStore.get().current.browse?.flatMap(c => c.stacks.flatMap(s => s.panes))).toEqual(['places', 'browser']);
    expect(layoutStore.get().saved).toEqual(named);
    expect(named[0].layout[0].stacks.map(s => s.panes[0])).toEqual(['places', 'tree', 'grid']);
  });
  it('the current version loads silently', async () => {
    stored.v = { v: LAYOUT_VERSION, current: {}, saved };
    expect(await loadLayouts()).toBeUndefined();
  });
});
