import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

vi.mock('../src/lib/starterMosh', () => ({ openStarterMosh: vi.fn() }));
vi.mock('../src/qol/qol', () => ({ toastError: vi.fn() }));
vi.mock('../src/components/Icon', () => ({ Icon: () => null }));
vi.mock('../src/state/store', async (original) => ({
  ...await original<typeof import('../src/state/store')>(),
  useStore: (store: { get(): boolean }, select: (value: boolean) => boolean) => select(store.get()),
}));
import { openStarterMosh } from '../src/lib/starterMosh';
import { toastError } from '../src/qol/qol';
import { StarterMoshButton, startStarterMosh } from '../src/components/StarterMoshButton';

beforeEach(() => vi.clearAllMocks());
describe('durable Starter Mosh entry', () => {
  it('disables both entry points for one pending operation, including remounted buttons', async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(openStarterMosh).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = startStarterMosh();
    expect(await startStarterMosh()).toBe(false);
    expect(openStarterMosh).toHaveBeenCalledTimes(1);
    for (const home of [true, false]) {
      const html = renderToStaticMarkup(createElement(StarterMoshButton, { home }));
      expect(html).toContain('disabled=""');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('Preparing');
    }
    finish(true);
    expect(await pending).toBe(true);
    expect(renderToStaticMarkup(createElement(StarterMoshButton))).not.toContain('disabled=""');
  });
  it('becomes available again after cancellation or a failed preparation', async () => {
    vi.mocked(openStarterMosh).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(true);
    expect(await startStarterMosh()).toBe(false);
    expect(await startStarterMosh()).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(await startStarterMosh()).toBe(true);
    expect(renderToStaticMarkup(createElement(StarterMoshButton))).toContain('Starter Mosh');
  });
  it('mounts independently in Home and IN, with no project creation inside the tour', () => {
    const source = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
    expect(source('ws/home/HomeWs.tsx')).toContain('<StarterMoshButton home />');
    expect(source('ws/browse/BrowsePanes.tsx')).toContain('<StarterMoshButton />');
    expect(source('shell/TourLayer.tsx')).not.toContain('openStarterMosh');
  });
});
