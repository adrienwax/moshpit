import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/host', () => ({ host: { readConfig: vi.fn(), writeConfig: vi.fn() } }));
import { host } from '../src/host';
import { DEFAULT_SETTINGS, loadSettings, settingsStore } from '../src/state/ui';
afterEach(() => settingsStore.set(structuredClone(DEFAULT_SETTINGS)));

describe('60fps factory preference migration', () => {
  it('moves the old factory rate once while retaining unrelated preferences', async () => {
    vi.mocked(host.readConfig).mockResolvedValue({ theme: 'studio', defaults: { ...DEFAULT_SETTINGS.defaults, fps: '24', fpsV: undefined } });
    await loadSettings();
    expect(settingsStore.get().defaults).toMatchObject({ fps: '60', fpsV: 2 });
    expect(settingsStore.get().theme).toBe('studio');
  });
  it.each(['25', '30', '50', '60'])('retains a saved nonfactory %s fps preference', async fps => {
    vi.mocked(host.readConfig).mockResolvedValue({ defaults: { ...DEFAULT_SETTINGS.defaults, fps, fpsV: undefined } });
    await loadSettings();
    expect(settingsStore.get().defaults.fps).toBe(fps);
  });
  it('respects 24fps explicitly selected after migration', async () => {
    vi.mocked(host.readConfig).mockResolvedValue({ defaults: { ...DEFAULT_SETTINGS.defaults, fps: '24', fpsV: 2 } });
    await loadSettings();
    expect(settingsStore.get().defaults.fps).toBe('24');
  });
});
