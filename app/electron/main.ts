// Electron main process: one window, and the on-disk user/app config store (L13 — layouts,
// settings, recents live on disk, never in localStorage).
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { APP_LABEL } from '../version';
import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';
import { startEngineHost } from './engine-host';
import { startControlHost } from './control-host';
import { trackControlHostStartup, type ControlHostStatus } from '../control-status';
import { startProjectHost } from './project-host';
import { installProjectOpenGate, projectOpenArgs, projectPathFromArgs } from './project-open';
import { startLookHost } from './look-host';
import { handleScheme, isAppUrl, registerScheme, rendererUrl } from './protocol';
import { mediaRootsOf, previewDir, settingsPaths } from './engine-cache';

// Own userData folder (%APPDATA%/Moshpit 3), not the generic "Electron" one.
app.setName('Moshpit 3');
// Explicit review profiles keep baseline preferences, recovery journals and CT endpoints separate.
if (process.env.MOSHPIT_USER_DATA) {
  const profile = path.resolve(process.env.MOSHPIT_USER_DATA);
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}

// Phase 0.3: one instance per profile. Two used to share the untitled journal (the second one's
// session start deleted the first's) and could append to one file's journal at once. A second
// launch focuses the first window instead. The lock is per user-data dir, so test profiles are free.
const single = app.requestSingleInstanceLock({ moshpitProjectOpenArgs: process.argv.slice() });
if (!single) app.quit();
let pendingProjectPath: string | null = null;
let deliverProjectOpen: ((file: string) => void) | null = null;
function requestProjectFromArgs(argv: readonly string[], additionalData?: unknown) {
  try {
    const file = projectPathFromArgs(projectOpenArgs(argv, additionalData));
    if (file) {
      if (deliverProjectOpen) deliverProjectOpen(file);
      else pendingProjectPath = file;
    }
  } catch (error) {
    void app.whenReady().then(() => dialog.showErrorBox('Project request refused', String((error as Error).message)));
  }
}
if (single) requestProjectFromArgs(process.argv);
app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
  requestProjectFromArgs(argv, additionalData);
  const w = BrowserWindow.getAllWindows().find((x) => x.isFocusable() || x.isVisible());
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.focus();
});

// Packaged: the HAP-capable ffmpeg ships in resources/ffmpeg (electron-builder extraResources).
// Set before any window exists, so the render worker inherits it; the engine's findFfmpeg reads
// MOSHPIT_FFMPEG first. An explicit MOSHPIT_FFMPEG still wins.
if (app.isPackaged && !process.env.MOSHPIT_FFMPEG) process.env.MOSHPIT_FFMPEG = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');

// Tests (MOSHPIT_TEST_BACKGROUND): the window opens off-screen, inactive and off the taskbar,
// so a test run never takes over the screen of someone using the machine. Rendering keeps full
// speed: no background throttling, and an off-screen window still counts as visible.
const background = !!process.env.MOSHPIT_TEST_BACKGROUND;
if (background) app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// A-1: the app is served from moshpit:// (protocol.ts). Registered before ready, handled after.
registerScheme();

// Trust boundary: the renderer may only name these files, never a path.
const CONFIG_FILES = new Set(['layouts', 'settings', 'previews']);

function configPath(name: string): string {
  if (!CONFIG_FILES.has(name)) throw new Error(`config: unknown file ${name}`);
  return path.join(app.getPath('userData'), 'config', `${name}.json`);
}

ipcMain.handle('config:read', async (_e, name: string) => {
  try {
    return JSON.parse(await fs.readFile(configPath(name), 'utf8'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
});

ipcMain.handle('config:write', async (_e, name: string, data: unknown) => {
  const p = configPath(name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  // Write-then-rename so a crash mid-write never leaves a torn config.
  await fs.writeFile(p + '.tmp', JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(p + '.tmp', p);
  return p;
});

const devUrl = process.env.MOSHPIT_DEV_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1280, // designed down to 1366×768 (Waxy); below 1280 controls would overlap
    minHeight: 700,
    backgroundColor: '#08090c', // --surface-void (DESIGN-SYSTEM.md), so launch never flashes another colour
    title: APP_LABEL,
    autoHideMenuBar: true,
    ...(background ? { x: -32000, y: -32000, show: false, skipTaskbar: true, focusable: false } : {}),
    webPreferences: {
      backgroundThrottling: !background,
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // A-1: the window never navigates away from the app (a dropped file, a stray link, a redirect).
  win.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url) && url !== devUrl) e.preventDefault(); });
  // Links never open inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  let controlStatus: ControlHostStatus = 'starting';
  ipcMain.handle('control:status', event => event.sender === win.webContents ? controlStatus : 'unknown');
  win.once('closed', () => ipcMain.removeHandler('control:status'));
  const reportControlStatus = (status: ControlHostStatus) => {
    controlStatus = status;
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('control:status-changed', status);
  };
  const requestOpen = installProjectOpenGate(win);
  deliverProjectOpen = requestOpen;
  if (pendingProjectPath) { requestOpen(pendingProjectPath); pendingProjectPath = null; }
  win.once('closed', () => { if (deliverProjectOpen === requestOpen) deliverProjectOpen = null; });
  // The UI navigates before the worker exists, so it is the app's first page (tests attach to it).
  // Every host below registers its handlers in this same tick, before the page can call them.
  void win.loadURL(devUrl || rendererUrl());
  // Open / save / autosave journal / crash recovery / the unsaved-changes prompt on close.
  startProjectHost(win);
  startLookHost(win);
  // Engine lane: the crash-isolated render worker, wired to this window by a MessagePort.
  startEngineHost(win);
  // Engine lane: the optional CT Route B control server (CONTROL-PROTOCOL.md).
  void trackControlHostStartup(() => startControlHost(win, { throttle: !background }), reportControlStatus).catch((e) => console.error('control server not started:', e));
  if (background) win.showInactive();
  // V9 (UX round 2): open filling the screen. Maximised keeps the title bar and its controls; F11
  // toggles true fullscreen (the menu bar is hidden, so it would otherwise have no way back).
  if (!background) win.maximize();
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
}

app.whenReady().then(() => {
  if (!single) return;
  // No application menu: Moshpit never used it, and with autoHideMenuBar a released Alt (the
  // coarse modifier for scrubbing values, Phase 0.5) popped the menu bar open and shifted the layout.
  Menu.setApplicationMenu(null);
  handleScheme(__dirname, () => {
    const ud = app.getPath('userData'), p = settingsPaths(ud);
    return previewDir(ud, p.cache, mediaRootsOf(p.media, app.getPath('videos')));
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
