import path from 'node:path';
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';

/** Electron may reorder argv and insert switches; its additionalData preserves the original list. */
export function projectOpenArgs(argv: readonly string[], additionalData?: unknown): readonly string[] {
  if (!additionalData || typeof additionalData !== 'object' || !Object.hasOwn(additionalData, 'moshpitProjectOpenArgs')) return argv;
  const original = (additionalData as { moshpitProjectOpenArgs?: unknown }).moshpitProjectOpenArgs;
  if (!Array.isArray(original) || !original.every(arg => typeof arg === 'string')) throw new Error('Invalid project request arguments.');
  return original;
}

/** One explicit local project, never a URL, command or implicit positional file. */
export function projectPathFromArgs(argv: readonly string[]): string | null {
  const flags = argv.flatMap((arg, i) => arg === '--project' || arg.startsWith('--project=') ? [i] : []);
  if (!flags.length) return null;
  const at = flags[0], file = argv[at + 1];
  if (flags.length !== 1 || argv[at] !== '--project' || !file || argv[at + 2] && !argv[at + 2].startsWith('--')) {
    throw new Error('Use --project followed by one absolute .mosh file path.');
  }
  if (!/^[a-z]:[\\/]/i.test(file) || /[\x00-\x1f<>"|?*]/.test(file) || file.slice(2).includes(':') || path.extname(file).toLowerCase() !== '.mosh') {
    throw new Error('The project must be an absolute local .mosh file path.');
  }
  return path.normalize(file);
}

/** Keep the latest explicit request until recovery/session setup and its listener are ready. */
export function installProjectOpenGate(win: BrowserWindow): (file: string) => void {
  const contents = win.webContents;
  let ready = false, navigating = false;
  let pending: string | null = null;
  const deliver = () => {
    if (!ready || !pending || win.isDestroyed() || contents.isDestroyed() || contents.isCrashed()) return;
    const file = pending;
    pending = null;
    contents.send('project:open-requested', file);
  };
  const onReady = (event: IpcMainEvent) => {
    if (navigating || win.isDestroyed() || contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
    ready = true;
    deliver();
  };
  ipcMain.on('project:open-ready', onReady);
  contents.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument) { ready = false; navigating = true; }
  });
  contents.on('did-navigate', () => { ready = false; navigating = false; });
  contents.on('render-process-gone', () => { ready = false; });
  win.once('closed', () => {
    ready = false;
    pending = null;
    ipcMain.removeListener('project:open-ready', onReady);
  });
  return file => { pending = file; deliver(); };
}
