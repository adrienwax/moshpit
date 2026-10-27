import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/qol/qol', () => ({ confirmAction: vi.fn(), toast: vi.fn(), toastError: vi.fn(), asError: vi.fn() }));
import { PROJECT_RESOLUTIONS } from '../src/lib/resolutions';
import { DEFAULT_SETTINGS, settingsStore } from '../src/state/ui';
import { changeProjectFormat, emptyDoc, getDoc, projectStore, redo, setExportConfig, undo } from '../src/state/project';
import { PRESETS, RESOLUTIONS, exportPresetDescription, exportPresetMatches, resolveExportPreset } from '../src/state/render';
import { applyPreset } from '../src/ws/render/RenderPanes';
import { parseProject, serializeProject } from '../../engine/src/project/io';

beforeEach(() => {
  settingsStore.set(DEFAULT_SETTINGS);
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
});
afterEach(() => settingsStore.set(DEFAULT_SETTINGS));
const portrait = { w: 1080, h: 1920 };

describe('portrait project and export workflow', () => {
  it('shares portrait choices without changing the landscape default', () => {
    expect(PROJECT_RESOLUTIONS[0]).toMatchObject({ w: 1920, h: 1080 });
    expect(PROJECT_RESOLUTIONS).toContainEqual({ ...portrait, label: '1080×1920' });
    expect(RESOLUTIONS).toEqual(expect.arrayContaining(PROJECT_RESOLUTIONS));
    expect(emptyDoc().settings.working).toEqual({ w: 1920, h: 1080 });
    settingsStore.set({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, resolution: '1080×1920' } });
    expect(emptyDoc().settings.working).toEqual(portrait);
    expect(emptyDoc().exportConfig).toMatchObject({ width: 1080, height: 1920 });
  });
  it('changes working size and matching export in one undo step, then round-trips both', async () => {
    const before = getDoc();
    expect(await changeProjectFormat('Portrait', { working: portrait, fps: { num: 30, den: 1 } })).toBe(true);
    const after = getDoc();
    expect(after.settings.working).toEqual(portrait);
    expect(after.exportConfig).toEqual({ ...before.exportConfig, width: 1080, height: 1920 });
    expect(projectStore.get().past).toHaveLength(1);
    undo(); expect(getDoc()).toEqual(before);
    redo(); expect(getDoc()).toEqual(after);
    const reopened = parseProject(serializeProject(after)).doc;
    expect(reopened.settings).toEqual(after.settings);
    expect(reopened.exportConfig).toEqual(after.exportConfig);
  });
  it.each([{ width: 1280, height: 720 }, { width: 1920, height: 720 }, { width: 720, height: 1080 }])('preserves a deliberate export override %j', async size => {
    setExportConfig({ ...size, audio: false, outDir: 'E:/test-output' }, 'Custom export');
    const before = getDoc();
    await changeProjectFormat('Portrait', { working: portrait });
    expect(getDoc().exportConfig).toEqual(before.exportConfig);
    expect(getDoc().settings.working).toEqual(portrait);
    undo(); expect(getDoc()).toEqual(before);
    redo(); expect(getDoc().exportConfig).toEqual(before.exportConfig);
  });
  it.each(PROJECT_RESOLUTIONS)('applies all codec and proxy presets at the project aspect: $label', ({w,h}) => {
    const doc = emptyDoc(); doc.settings.working = { w, h };
    doc.exportConfig = { ...doc.exportConfig, audio: false, outDir: 'E:/test-output', range: [0, 29] };
    projectStore.set({ doc, past: [], future: [] });
    PRESETS.forEach((p, i) => {
      applyPreset(i);
      const ec = getDoc().exportConfig;
      const expectedScale = p.size === 'proxy' ? Math.min(1, 960 / Math.max(w, h)) : 1;
      expect(ec.width).toBe(w * expectedScale); expect(ec.height).toBe(h * expectedScale);
      expect(ec.width / ec.height).toBe(w / h);
      expect(ec).toMatchObject({ format: p.format, audio: false, outDir: 'E:/test-output', range: [0, 29] });
      expect(exportPresetMatches(p, ec, {w,h})).toBe(true);
      expect(exportPresetDescription(p, {w,h})).toContain(ec.width + '×' + ec.height);
    });
  });
  it('portrait preset is not selected for a landscape export; small proxy does not upscale', () => {
    const delivery = PRESETS.find(p => p.name === 'H.264')!;
    expect(exportPresetMatches(delivery, emptyDoc().exportConfig, portrait)).toBe(false);
    const proxy = PRESETS.find(p => p.size === 'proxy')!;
    expect(resolveExportPreset(proxy, portrait)).toMatchObject({ width: 540, height: 960 });
    expect(resolveExportPreset(proxy, {w:270,h:480})).toMatchObject({ width: 270, height: 480 });
  });
});
