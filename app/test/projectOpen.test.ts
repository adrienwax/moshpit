import { EventEmitter } from 'node:events';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', async () => ({ ipcMain: new (await import('node:events')).EventEmitter() }));
import { ipcMain, type BrowserWindow } from 'electron';
import { installProjectOpenGate, projectOpenArgs, projectPathFromArgs } from '../electron/project-open';

describe('explicit project arguments', () => {
  it('preserves a local path containing spaces, unicode and shell punctuation as data', () => {
    const file = 'E:/Examples/Élan & light/scene (1).mosh';
    expect(projectPathFromArgs(['Moshpit.exe', '--project', file])).toBe(path.normalize(file));
    expect(projectPathFromArgs(['Moshpit.exe', '--user-data-dir=E:/private', '--project', file, '--mute-audio'])).toBe(path.normalize(file));
  });
  it('does not interpret positional files or unrelated Electron arguments', () => {
    expect(projectPathFromArgs(['Moshpit.exe', 'E:/other.mosh', '--mute-audio'])).toBeNull();
  });
  it.each([
    ['--project'], ['--project=E:/a.mosh'], ['--project', 'E:/a.mosh', '--project', 'E:/b.mosh'],
    ['--project', 'E:/a.mosh', 'E:/b.mosh'], ['--project', 'relative.mosh'], ['--project', 'file:///E:/a.mosh'],
    ['--project', 'https://example.test/a.mosh'], ['--project', 'E:/script.cmd'], ['--project', 'E:/a.mosh\n'],
    ['--project', 'E:/stream:other.mosh'], ['--project', 'E:/wild*.mosh'], ['--project', '\\rooted.mosh'], ['--project', '\\\\server\\share\\a.mosh'],
  ])('rejects malformed or ambiguous argv %j', (...argv) => {
    expect(() => projectPathFromArgs(argv)).toThrow();
  });
});

function fixture() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn(), isDestroyed: () => false, isCrashed: () => false });
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  const request = installProjectOpenGate(win as unknown as BrowserWindow);
  const ready = () => ipcMain.emit('project:open-ready', { sender: contents, senderFrame: contents.mainFrame });
  return { contents, win, request, ready };
}
beforeEach(() => ipcMain.removeAllListeners());
describe('project open readiness', () => {
  it('retains only the latest pre-boot choice and sends it once, then handles warm requests', () => {
    const f = fixture();
    f.request('E:/A.mosh'); f.request('E:/B.mosh');
    expect(f.contents.send).not.toHaveBeenCalled();
    f.ready(); f.ready();
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith('project:open-requested', 'E:/B.mosh');
    f.request('E:/C.mosh');
    expect(f.contents.send).toHaveBeenLastCalledWith('project:open-requested', 'E:/C.mosh');
  });
  it('ignores foreign contents, subframes and stale readiness during replacement navigation', () => {
    const f = fixture(); f.request('E:/A.mosh');
    ipcMain.emit('project:open-ready', { sender: {}, senderFrame: f.contents.mainFrame });
    ipcMain.emit('project:open-ready', { sender: f.contents, senderFrame: {} });
    f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); f.ready();
    expect(f.contents.send).not.toHaveBeenCalled();
    f.contents.emit('did-navigate'); f.ready();
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith('project:open-requested', 'E:/A.mosh');
  });
  it('keeps an undelivered request through renderer loss and removes IPC on closure', () => {
    const f = fixture(); f.ready(); f.contents.emit('render-process-gone'); f.request('E:/A.mosh');
    expect(f.contents.send).not.toHaveBeenCalled();
    f.ready(); expect(f.contents.send).toHaveBeenCalledOnce();
    f.win.emit('closed'); expect(ipcMain.listenerCount('project:open-ready')).toBe(0);
  });
});

describe('native second-instance argument transport', () => {
  it('uses the exact original arguments when Chromium inserts a switch between --project and its value', () => {
    const file = 'E:/Examples/Élan & light/scene (1).mosh';
    const original = ['Moshpit.exe', '--project', file];
    const native = ['Moshpit.exe', '--project', '--allow-file-access-from-files', file];
    expect(() => projectPathFromArgs(native)).toThrow();
    expect(projectPathFromArgs(projectOpenArgs(native, { moshpitProjectOpenArgs: original }))).toBe(path.normalize(file));
    expect(projectOpenArgs(native, { moshpitProjectOpenArgs: original })).toEqual(original);
  });
  it('keeps strict file validation and rejects malformed transport metadata', () => {
    expect(() => projectOpenArgs([], { moshpitProjectOpenArgs: 'E:/a.mosh' })).toThrow();
    expect(() => projectOpenArgs([], { moshpitProjectOpenArgs: [null] })).toThrow();
    expect(() => projectPathFromArgs(projectOpenArgs([], { moshpitProjectOpenArgs: ['--project', 'https://example.test/a.mosh'] }))).toThrow();
    expect(() => projectPathFromArgs(projectOpenArgs([], { moshpitProjectOpenArgs: ['--project', 'E:/a.mosh', '--project', 'E:/b.mosh'] }))).toThrow();
  });
  it('preserves ordinary no-project activation and legacy validated argv fallback', () => {
    expect(projectPathFromArgs(projectOpenArgs(['Moshpit.exe'], { moshpitProjectOpenArgs: ['Moshpit.exe'] }))).toBeNull();
    expect(projectPathFromArgs(projectOpenArgs(['--project', 'E:/a.mosh'], {}))).toBe(path.normalize('E:/a.mosh'));
  });
});
