// A thirty-second introduction built from three distinct clips, using only available frames.
// Import before replacing the current
// document, then retain the working format used for those imports (not the raw clips' FPS).
import { engine, type LibraryClip } from '../engine';
import { host } from '../host';
import { addBlock, addSource, commit, getDoc, setBypass, setSettings as setProjectSettings, transact } from '../state/project';
import { RECIPES, applyRecipe } from '../state/recipes';
import { setUi, settingsStore, uiStore } from '../state/ui';
import { newProject } from '../state/lifecycle';
import { toast, toastError } from '../qol/qol';
import { TEST_CLIPS_DIR } from './testClips';
import { timelineFrames } from './timeline';

const PICKS = ['02-bouncing-boxes-highcontrast.mp4', '07-fractal-zoom-camera-drift.mp4', '10-textured-surface-dolly-in.mp4'];
const SECONDS = 10;
const CLIP_COUNT = 3;
let building = false;

/** Prefer the authored shapes, fractal and texture; fill gaps with distinct playable clips. */
export function starterClips(clips: LibraryClip[]): LibraryClip[] {
  const seen = new Set<string>();
  const usable = clips.filter(c => {
    const p = c.probe, key = c.path.replaceAll('\\', '/').toLowerCase();
    if (seen.has(key) || c.pass !== true || !Number.isFinite(p.durationSec) || p.durationSec <= 0 ||
        !Number.isFinite(p.fps.num) || !Number.isFinite(p.fps.den) || p.fps.num <= 0 || p.fps.den <= 0 ||
        !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0 ||
        p.durationSec * p.fps.num / p.fps.den < 2) return false;
    seen.add(key);
    return true;
  });
  const preferred = PICKS.map(n => usable.find(c => c.name === n)).filter((c): c is LibraryClip => !!c);
  return [...preferred, ...usable.filter(c => !preferred.includes(c))].slice(0, CLIP_COUNT);
}

async function chooseClips(forcePicker: boolean): Promise<LibraryClip[] | null> {
  const current = uiStore.get().folder;
  if (!forcePicker) {
    // Bounded: two folders, never a recursive scan of the user's media collection.
    for (const folder of [...new Set([current, TEST_CLIPS_DIR].filter(Boolean))]) {
      try {
        if (folder === TEST_CLIPS_DIR) await engine.listDir(folder);
        const clips = starterClips(await engine.libraryClips(folder));
        if (clips.length === CLIP_COUNT) return clips;
      } catch { /* Missing optional folders lead to the user's folder picker. */ }
    }
  }
  if (!host.files) {
    toast('Open a Source folder containing three playable video clips, then try Starter Mosh again. The desktop app also offers a folder picker.', {
      kind: 'warn', action: { label: 'Open Source', run: () => setUi({ ws: 'browse' }) },
    });
    return null;
  }
  const folder = await host.files.pickFolder('Choose a folder with three video clips for Starter Mosh', current || undefined);
  if (!folder) return null;
  // Source navigation already permits indexing one folder outside the configured media roots.
  setUi({ folder });
  const clips = starterClips(await engine.libraryClips(folder));
  if (clips.length === CLIP_COUNT) return clips;
  toast('Starter Mosh needs three different playable video clips in the selected folder. Choose another folder or add clips in Source.', {
    kind: 'warn', action: { label: 'Choose folder', run: () => void openStarterMosh({ chooseFolder: true }) },
  });
  return null;
}

export async function openStarterMosh(options: { chooseFolder?: boolean } = {}): Promise<boolean> {
  if (building) return false;
  building = true;
  const before = getDoc();
  const unchanged = () => {
    if (getDoc() === before) return true;
    toast('Starter Mosh stopped because the current project changed. Your latest work was kept; try again when ready.', { kind: 'warn' });
    return false;
  };
  try {
    const use = await chooseClips(!!options.chooseFolder);
    if (!use || !unchanged()) return false;
    const format = { fps: { ...before.settings.fps }, working: { ...before.settings.working } };
    const quality = settingsStore.get().conformQuality;
    toast('Preparing up to ten seconds each from three distinct clips for Starter Mosh…', { kind: 'ok' });
    const imported: Awaited<ReturnType<typeof engine.importClip>['promise']>[] = [];
    for (const c of use) {
      const result = await engine.importClip(c.path, () => {}, {
        quality, proxyFirst: false, range: { startSec: 0, durSec: Math.min(SECONDS, c.probe.durationSec) },
      }).promise;
      if (!unchanged()) return false;
      const f = result.conform;
      if (!f.moshable || f.frames < 2 || f.fps.num * format.fps.den !== format.fps.num * f.fps.den || f.width !== format.working.w || f.height !== format.working.h) {
        toast('Those clips could not be prepared for the Starter Mosh format. Your project was kept; try three other clips.', { kind: 'warn' });
        return false;
      }
      imported.push(result);
    }
    // False distinguishes Cancel even when the old project has zero sources.
    if (!(await newProject())) return false;
    // No awaits below: content is added to the fresh document in one Undo step.
    transact(() => {
      setProjectSettings(format, 'Starter Mosh: working format');
      const ids: string[] = [];
      for (const { source, conform } of imported) {
        addSource({ ...source, marks: [{ id: `mark-${source.id}` as never, in: 0, out: conform.frames }] }, conform);
        const len = Math.min(conform.frames, Math.max(2, Math.round(format.fps.num / format.fps.den * SECONDS)));
        ids.push(addBlock(source.id, 0, len, ids.length === 1 ? 'motion' : 'picture'));
      }
      commit('Starter Mosh', d => void (d.name = 'Starter Mosh'));
      applyRecipe(ids[1], RECIPES.find(r => r.nm === 'Melt')!);
      const look = getDoc().timeline.blocks.find(b => b.id === ids[1])?.graph.nodes.find(n => n.kind === 'group.container');
      if (look) setBypass(ids[1] as never, look.id, true);
    });
    setUi({ ws: 'mosh' });
    const seconds = timelineFrames(getDoc().timeline.blocks) * format.fps.den / format.fps.num;
    const duration = Number(seconds.toFixed(1));
    toast(`Starter Mosh: ${duration}s from three distinct clips${seconds < 25 ? ' (short sources kept at their real length)' : ''}. Block 1 supplies the picture; block 2 smears it; block 3 introduces fresh texture. Select Melt on block 2 and turn Bypass off. Your working size and frame rate are kept.`, { kind: 'ok', ms: 12000 });
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    building = false;
  }
}
