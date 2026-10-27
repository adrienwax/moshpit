import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';
const ipc = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>(),
  saveDialog: vi.fn(), openDialog: vi.fn(), message: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return ({
  app: { getPath: () => ipc.root },
  dialog: { showSaveDialog: ipc.saveDialog, showOpenDialog: ipc.openDialog, showMessageBox: ipc.message }, shell: {},
  ipcMain: Object.assign(new EventEmitter(), { handle: (name: string, fn: (...args: any[]) => any) => ipc.handlers.set(name, fn) }),
}); });
import { startProjectHost } from '../electron/project-host';
import { demoProject } from '../src/engine/mockProject';
import { Autosaver } from '../../engine/src/project/journal';
import { saveProjectFile } from '../../engine/src/project/io';
import { projectFileStem, suggestedProjectFile } from '../src/lib/projectFiles';

let testWindow: ReturnType<typeof fakeWindow>;
function fakeWindow() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false, close: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, isCrashed: vi.fn(() => false), send: vi.fn(), reload: vi.fn() }),
  });
}
const call = (name: string, ...args: unknown[]) => ipc.handlers.get(name)!(null, ...args);
beforeEach(() => {
  ipc.root = fs.mkdtempSync(path.join(os.tmpdir(), 'moshpit-project-files-'));
  ipc.handlers.clear(); ipcMain.removeAllListeners(); vi.clearAllMocks();
  vi.stubEnv('MOSHPIT_TEST', '');
  vi.stubEnv('MOSHPIT_NO_CLOSE_PROMPT', '');
  testWindow = fakeWindow(); startProjectHost(testWindow as never);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(ipc.root, { recursive: true, force: true }); });

describe('public .mosh project files', () => {
  it.each(['Town', 'Town.mosh', 'Town.MOSH', 'Town.moshpit.json', 'Town.json'])(
    'suggests exactly one public suffix for %s', name => {
      expect(suggestedProjectFile(name).toLowerCase()).toBe('town.mosh');
      expect(projectFileStem(`C:\\projects\\${name}`)).toBe('Town');
    });

  it('uses .mosh for new Save As and opens both public and legacy files', async () => {
    ipc.saveDialog.mockResolvedValue({ canceled: false, filePath: path.join(ipc.root, 'Town') });
    expect(await call('project:save-dialog', 'Town.moshpit.json')).toBe(path.join(ipc.root, 'Town.mosh'));
    expect(ipc.saveDialog.mock.calls[0][1]).toMatchObject({ defaultPath: 'Town.mosh', filters: [{ extensions: ['mosh'] }] });
    ipc.openDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(ipc.root, 'Old.moshpit.json')] });
    expect(await call('project:open-dialog')).toMatch(/Old\.moshpit\.json$/);
    expect(ipc.openDialog.mock.calls[0][1].filters[0].extensions).toEqual(['mosh', 'json', 'moshpit']);
  });

  it.each(['Town.mosh', 'Town.MOSH'])('retains an explicit %s without doubling', async name => {
    const file = path.join(ipc.root, name);
    ipc.saveDialog.mockResolvedValue({ canceled: false, filePath: file });
    expect(await call('project:save-dialog', 'Town')).toBe(file);
  });

  it('confirms the real destination if a typed legacy name resolves to an existing .mosh', async () => {
    const target = path.join(ipc.root, 'Town.mosh');
    fs.writeFileSync(target, 'existing owner work');
    ipc.saveDialog.mockResolvedValue({ canceled: false, filePath: path.join(ipc.root, 'Town.moshpit.json') });
    ipc.message.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 });
    expect(await call('project:save-dialog', 'Town')).toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toBe('existing owner work');
    expect(await call('project:save-dialog', 'Town')).toBe(target);
  });

  it.each(['Town.mosh', 'Old.moshpit.json'])('round-trips %s with recovery and recents intact', async name => {
    const file = path.join(ipc.root, name), doc = demoProject();
    expect((await call('project:save', file, doc)).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).format).toBe('moshpit.project');
    expect((await call('project:load', file)).value.doc).toEqual(doc);
    const edited = { ...doc, name: 'Unfinished town' };
    new Autosaver(file, doc).commit(edited);
    expect((await call('project:load', file)).value.recovery.doc.name).toBe(edited.name);
    expect((await call('project:pending-recovery')).value.find((r: any) => r.file === file).doc.name).toBe(edited.name);
    expect(await call('project:recents')).toContain(file);
    expect((await call('project:save', file, edited)).value).toBe(file);
    expect((await call('project:pending-recovery')).value).toEqual([]);
  });

  it('still discovers a legacy deferred recovery alongside a new-format project', async () => {
    const folder = path.join(ipc.root, 'recovery'); fs.mkdirSync(folder);
    const old = path.join(folder, 'deferred-1234abcd.moshpit.json'), doc = demoProject();
    saveProjectFile(old, doc); new Autosaver(old, doc).commit({ ...doc, name: 'Old deferred work' });
    await call('project:save', path.join(ipc.root, 'New.mosh'), doc);
    expect((await call('project:pending-recovery')).value.map((r: any) => r.doc.name)).toContain('Old deferred work');
  });
  it('holds an early native close until ready and preserves the journal until explicit approval', async () => {
    const doc = demoProject(); await call('project:session', null, doc, null);
    ipcMain.emit('project:journal', {}, { ...doc, name: 'Keep this unsaved edit' });
    const journal = path.join(ipc.root, 'recovery', 'untitled.moshpit.json.journal');
    const before = fs.readFileSync(journal, 'utf8');
    const preventDefault = vi.fn(); testWindow.emit('close', { preventDefault });
    expect(preventDefault).toHaveBeenCalled(); expect(testWindow.webContents.send).not.toHaveBeenCalled();
    ipcMain.emit('app:close-ready', { sender: testWindow.webContents, senderFrame: testWindow.webContents.mainFrame });
    expect(testWindow.webContents.send).toHaveBeenCalledExactlyOnceWith('app:close-requested');
    expect(fs.readFileSync(journal, 'utf8')).toBe(before); expect(testWindow.close).not.toHaveBeenCalled();
    await call('app:close-now', true);
    expect(fs.existsSync(journal)).toBe(false); expect(testWindow.close).toHaveBeenCalledTimes(1);
  });
  it('allows a dead renderer to close without discarding its recovery journal', async () => {
    const doc = demoProject(); await call('project:session', null, doc, null);
    ipcMain.emit('project:journal', {}, { ...doc, name: 'Recover after renderer failure' });
    const journal = path.join(ipc.root, 'recovery', 'untitled.moshpit.json.journal');
    const before = fs.readFileSync(journal, 'utf8');
    testWindow.webContents.isCrashed.mockReturnValue(true);
    const preventDefault = vi.fn(); testWindow.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fs.readFileSync(journal, 'utf8')).toBe(before);
  });

});
