import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settingsStore, setUi, toggleSettings, uiStore } from '../src/state/ui';
import { emptyDoc } from '../src/state/project';

const initialUi = uiStore.get();
afterEach(() => { settingsStore.set(DEFAULT_SETTINGS); uiStore.set(initialUi); });

describe('practical preference behavior', () => {
  it('returns to the actual previous workspace, including direct folder-settings navigation', () => {
    setUi({ ws: 'node', playhead: 73 });
    toggleSettings();
    setUi({ settingsPage: 'folders' });
    toggleSettings();
    expect(uiStore.get().ws).toBe('node');
    expect(uiStore.get().playhead).toBe(73);
    setUi({ ws: 'browse' });
    setUi({ ws: 'settings', settingsPage: 'folders' });
    toggleSettings();
    expect(uiStore.get().ws).toBe('browse');
  });
  it.each(['24', '25', '30', '50', '60'])('uses %s fps for new projects without changing old ones', (fps) => {
    const before = emptyDoc();
    settingsStore.set({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, fps } });
    expect(emptyDoc().settings.fps).toEqual({ num: Number(fps), den: 1 });
    expect(before.settings.fps).toEqual({ num: 60, den: 1 });
  });
  it('falls back to a valid frame rate for an invalid old preference', () => {
    settingsStore.set({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, fps: 'broken' } });
    expect(emptyDoc().settings.fps).toEqual({ num: 60, den: 1 });
  });
  it('uses the selected new-project resolution for effect processing as well as export', () => {
    const old = emptyDoc();
    settingsStore.set({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, resolution: '3840×2160' } });
    const next = emptyDoc();
    expect(next.settings.working).toEqual({ w: 3840, h: 2160 });
    expect(next.exportConfig).toMatchObject({ width: 3840, height: 2160 });
    expect(old.settings.working).toEqual({ w: 1920, h: 1080 });
  });
});
