import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/host', () => ({ host: { writeConfig: vi.fn(async () => 'settings.json') } }));
import { host } from '../src/host';
import { DEFAULT_SETTINGS, flushSettings, settingsSaveStore, settingsStore, setSettings, updateSettingsDurably } from '../src/state/ui';

beforeEach(() => { vi.useFakeTimers(); settingsStore.set(structuredClone(DEFAULT_SETTINGS)); vi.mocked(host.writeConfig).mockReset().mockResolvedValue('settings.json'); });
afterEach(async () => { await flushSettings(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('settings persistence', () => {
  it('does not publish a saved preset on disk failure and allows a retry', async () => {
    vi.mocked(host.writeConfig).mockRejectedValueOnce(new Error('Disk full'));
    const save = () => updateSettingsDurably(s => { s.effectPresets.fx = [{ id: 'one', name: 'Warm', params: { amount: 0.2 } }]; });
    await expect(save()).rejects.toThrow('Disk full');
    expect(settingsStore.get().effectPresets.fx).toBeUndefined();
    expect(settingsSaveStore.get().error).toBe('Disk full');
    await save();
    expect(settingsStore.get().effectPresets.fx[0].name).toBe('Warm');
    expect(settingsSaveStore.get().error).toBeUndefined();
  });
  it('retains settings changed during a preset write and serializes the merged snapshot', async () => {
    let release!: () => void;
    vi.mocked(host.writeConfig).mockImplementationOnce(() => new Promise<string>(resolve => { release = () => resolve('settings.json'); }));
    const pending = updateSettingsDurably(s => { s.effectPresets.fx = [{ id: 'one', name: 'Warm', params: {} }]; });
    await Promise.resolve();
    expect(settingsStore.get().effectPresets.fx).toBeUndefined();
    setSettings(s => { s.theme = 'studio'; });
    release();
    await pending;
    await flushSettings();
    expect(settingsStore.get().theme).toBe('studio');
    const saved = vi.mocked(host.writeConfig).mock.calls.at(-1)![1] as typeof DEFAULT_SETTINGS;
    expect(saved.theme).toBe('studio');
    expect(saved.effectPresets.fx[0].name).toBe('Warm');
  });
  it('serializes concurrent durable edits without losing either preset', async () => {
    await Promise.all(['first', 'second'].map(id => updateSettingsDurably(s => {
      (s.effectPresets.fx ??= []).push({ id, name: id, params: {} });
    })));
    expect(settingsStore.get().effectPresets.fx.map(p => p.id)).toEqual(['first', 'second']);
  });
});
