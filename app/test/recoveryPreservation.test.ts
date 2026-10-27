import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const ipc = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('electron', () => ({
  app: { getPath: () => ipc.root },
  dialog: {}, shell: {},
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => ipc.handlers.set(name, fn), on: vi.fn() },
}));
import { startProjectHost } from '../electron/project-host';
import { demoProject } from '../src/engine/mockProject';
import { Autosaver, recover } from '../../engine/src/project/journal';
import { loadProjectFile, saveProjectFile } from '../../engine/src/project/io';
import type { PendingRecovery } from '../src/host';

const call = (name: string, ...args: unknown[]) => ipc.handlers.get(name)!(null, ...args);
const untitled = () => path.join(ipc.root, 'recovery', 'untitled.moshpit.json');
function crashedUntitled() {
  const base = demoProject(), edited = { ...base, name: 'Untitled work to retain' };
  fs.mkdirSync(path.dirname(untitled()), { recursive: true });
  saveProjectFile(untitled(), base);
  new Autosaver(untitled(), base).commit(edited);
  return edited;
}
beforeEach(() => {
  ipc.root = fs.mkdtempSync(path.join(os.tmpdir(), 'moshpit-recovery-test-'));
  ipc.handlers.clear();
  startProjectHost({ webContents: { on: vi.fn() }, on: vi.fn(), once: vi.fn() } as never);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(ipc.root, { recursive: true, force: true }); });

describe('deferred untitled crash recovery', () => {
  it('retains deferred untitled work when Not now starts a fresh session', async () => {
    const edited = crashedUntitled();
    const next = { ...demoProject(), id: 'new-session' as never, name: 'Fresh project' };
    expect((await call('project:pending-recovery')).value).toHaveLength(1);
    expect((await call('project:session', null, next, null)).ok).toBe(true);
    const pending: PendingRecovery[] = (await call('project:pending-recovery')).value;
    expect(pending).toHaveLength(1);
    expect(pending[0].doc.name).toBe(edited.name);
    expect(pending[0].file).not.toBeNull();
    expect(recover(pending[0].file!)?.doc).toEqual(edited);
    expect(loadProjectFile(untitled()).doc.name).toBe(next.name);
    await call('project:discard-recovery', pending[0].file);
    expect((await call('project:pending-recovery')).value).toEqual([]);
  });

  it('retains deferred untitled work when another project is recovered', async () => {
    crashedUntitled();
    const restored = { ...demoProject(), id: 'another-project' as never, name: 'Named recovery' };
    expect((await call('project:session', null, demoProject(), restored)).ok).toBe(true);
    const pending: PendingRecovery[] = (await call('project:pending-recovery')).value;
    expect(pending.map(p => p.doc.name).sort()).toEqual(['Named recovery', 'Untitled work to retain']);
  });

  it('does not duplicate the untitled recovery that is actively being recovered', async () => {
    const edited = crashedUntitled(), restored = { ...edited, name: `${edited.name} (recovered)` };
    expect((await call('project:session', null, demoProject(), restored)).ok).toBe(true);
    const pending: PendingRecovery[] = (await call('project:pending-recovery')).value;
    expect(pending).toHaveLength(1);
    expect(pending[0].file).toBeNull();
    expect(pending[0].doc.name).toBe(restored.name);
  });

  it('preserves distinct edits even when a recovered Save As copy has the same project id', async () => {
    const edited = crashedUntitled();
    const restored = { ...edited, settings: { ...edited.settings, bpm: 151 }, name: 'Saved copy recovery' };
    await call('project:session', null, demoProject(), restored);
    const pending: PendingRecovery[] = (await call('project:pending-recovery')).value;
    expect(pending.map(p => p.doc.name).sort()).toEqual(['Saved copy recovery', 'Untitled work to retain']);
  });

  it('preserves work after the renderer crashes while the main process keeps its session', async () => {
    const initial = demoProject();
    await call('project:session', null, initial, null);
    const edited = { ...initial, name: 'Crashed renderer work' };
    new Autosaver(untitled(), initial).commit(edited);
    await call('project:pending-recovery'); // fresh renderer's boot
    await call('project:session', null, { ...initial, name: 'New session' }, null);
    const pending: PendingRecovery[] = (await call('project:pending-recovery')).value;
    expect(pending.map(p => p.doc.name)).toEqual(['Crashed renderer work']);
  });

  it('aborts setup without overwriting the original if preserving its journal fails', async () => {
    const edited = crashedUntitled();
    vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(new Error('simulated copy failure'));
    expect((await call('project:session', null, demoProject(), null)).ok).toBe(false);
    expect(recover(untitled())?.doc).toEqual(edited);
  });
});
