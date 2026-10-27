import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

/** Retain an early Quit until this document can offer its Save / Discard / Cancel prompt.
 * Readiness means lifecycle boot (including recovery) finished, not just DOM loaded.
 * This gate never closes the window or deletes recovery data itself.
 */
export function installCloseRequestGate(win: BrowserWindow): () => void {
  const contents = win.webContents;
  let ready = false;
  let navigating = false;
  let pending = false;
  const deliver = () => {
    if (!ready || !pending || win.isDestroyed() || contents.isDestroyed() || contents.isCrashed()) return;
    pending = false;
    contents.send('app:close-requested');
  };
  const onReady = (event: IpcMainEvent) => {
    if (navigating || win.isDestroyed() || contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
    ready = true;
    deliver();
  };
  ipcMain.on('app:close-ready', onReady);
  // Hash changes and subframe loads keep the current document's listener alive.
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) { ready = false; navigating = true; }
  });
  // The old mainFrame can still send IPC before the replacement commits. Do not
  // accept its last boot-ready message as readiness for the new document.
  contents.on('did-navigate', () => { ready = false; navigating = false; });
  contents.on('render-process-gone', () => { ready = false; });
  win.once('closed', () => {
    ready = false;
    pending = false;
    ipcMain.removeListener('app:close-ready', onReady);
  });
  return () => { pending = true; deliver(); };
}
