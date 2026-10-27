import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter() };
});
import { ipcMain, type BrowserWindow } from 'electron';
import { installCloseRequestGate } from '../electron/close-request';

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {}, send: vi.fn(), isDestroyed: () => false, isCrashed: () => false,
  });
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  const request = installCloseRequestGate(win as unknown as BrowserWindow);
  const ready = () => ipcMain.emit('app:close-ready', { sender: contents, senderFrame: contents.mainFrame });
  return { contents, win, request, ready };
}
beforeEach(() => ipcMain.removeAllListeners());
describe('native close readiness handshake', () => {
  it('retains repeated early Quit requests and delivers once after lifecycle readiness', () => {
    const { request, ready, contents } = fixture();
    request(); request(); expect(contents.send).not.toHaveBeenCalled();
    ready(); ready(); expect(contents.send).toHaveBeenCalledExactlyOnceWith('app:close-requested');
  });
  it('delivers normal ready closes and allows another request after a cancelled prompt', () => {
    const { request, ready, contents } = fixture();
    ready(); expect(contents.send).not.toHaveBeenCalled();
    request(); request(); expect(contents.send).toHaveBeenCalledTimes(2);
  });
  it('ignores readiness from another window, a subframe or an obsolete main frame', () => {
    const { request, ready, contents } = fixture();
    request();
    ipcMain.emit('app:close-ready', { sender: {}, senderFrame: contents.mainFrame });
    ipcMain.emit('app:close-ready', { sender: contents, senderFrame: {} });
    expect(contents.send).not.toHaveBeenCalled(); ready();
    expect(contents.send).toHaveBeenCalledTimes(1);
  });
  it('queues again across full reload but not hash navigation or subframe loads', () => {
    const { request, ready, contents } = fixture();
    ready();
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    request();
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    request(); expect(contents.send).toHaveBeenCalledTimes(2);
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    request(); request(); expect(contents.send).toHaveBeenCalledTimes(2);
    ready(); expect(contents.send).toHaveBeenCalledTimes(2); // old frame, still navigating
    contents.emit('did-navigate');
    ready(); ready(); expect(contents.send).toHaveBeenCalledTimes(3);
  });
  it('requires fresh readiness after renderer failure and never closes/discards by itself', () => {
    const { request, ready, contents, win } = fixture();
    const closed = vi.fn(); win.on('closed', closed);
    ready(); contents.emit('render-process-gone'); request();
    expect(contents.send).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
    ready(); expect(contents.send).toHaveBeenCalledTimes(1);
  });
  it('does not send to a crashed renderer even if a readiness message arrives late', () => {
    const { request, ready, contents } = fixture();
    contents.isCrashed = () => true; request(); ready();
    expect(contents.send).not.toHaveBeenCalled();
    contents.isCrashed = () => false; ready();
    expect(contents.send).toHaveBeenCalledTimes(1);
  });
  it('removes the IPC listener and pending request when its window closes', () => {
    const { request, ready, contents, win } = fixture();
    request(); win.isDestroyed = () => true; win.emit('closed'); ready(); request();
    expect(contents.send).not.toHaveBeenCalled();
    expect(ipcMain.listenerCount('app:close-ready')).toBe(0);
  });
});
