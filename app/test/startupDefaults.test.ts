import { expect, it, vi } from 'vitest';
vi.mock('../src/engine', async importOriginal => ({ ...await importOriginal<object>(), engineKind: 'real' }));
import { initializeProjectDefaults, projectStore } from '../src/state/project';
import { DEFAULT_SETTINGS, settingsStore } from '../src/state/ui';
it('adopts loaded preferences once before the first desktop project is used', () => {
  settingsStore.set({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, fps: '25', resolution: '3840×2160' } });
  initializeProjectDefaults();
  expect(projectStore.get().doc.settings).toMatchObject({ fps: { num: 25, den: 1 }, working: { w: 3840, h: 2160 } });
  const current = projectStore.get().doc;
  settingsStore.set(DEFAULT_SETTINGS);
  initializeProjectDefaults();
  expect(projectStore.get().doc).toBe(current);
});
