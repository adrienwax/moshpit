// Main-process side of the engine: the crash-isolated render worker (engine lane).
//
// The engine runs in a hidden BrowserWindow, not in the UI renderer: WebCodecs and WebGL2 need a
// renderer process, and keeping it separate means a GPU or decoder crash takes down the worker,
// not the UI. Main stays thin — it never touches media. It creates a MessageChannel and hands one
// end to the UI window and the other to the worker, so requests and frame buffers go renderer to
// renderer without passing through main. When the worker dies, main starts a new one, wires a new
// channel, and tells the UI (WORKER_CRASHED); the UI client re-sends its project snapshot.

import { BrowserWindow, MessageChannelMain, ipcMain, app, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { recordWorkerCrash } from './worker-crash-log';
import { workerUrl } from './protocol';
import { engineCacheDir, engineCacheRoot, mediaRootsOf, migrateEngineCache, settingsPaths, sweepPartialEncodes } from './engine-cache';

export interface EngineHost {
  restart(): void;
  worker(): BrowserWindow | null;
}

/** UI lane: the Settings → Media root(s), read when the worker starts (';'-separated). Empty = engine default. */
function settingsPath(key: 'media' | 'cache'): string {
  try {
    const s = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'config', 'settings.json'), 'utf8'));
    return typeof s?.paths?.[key] === 'string' ? s.paths[key] : '';
  } catch {
    return '';
  }
}
const libraryFromSettings = () => settingsPath('media');

export function startEngineHost(ui: BrowserWindow): EngineHost {
  // Before the worker opens it: move the engine's cache out of Chromium's "Cache" (engine-cache.ts).
  const moved = migrateEngineCache(app.getPath('userData'));
  if (moved.length) console.log('engine cache moved to engine-cache:', moved.join(', '));
  const cacheRoot = engineCacheRoot(app.getPath('userData'), settingsPath('cache'), process.env, mediaRootsOf(settingsPaths(app.getPath('userData')).media, app.getPath('videos')));
  console.log('engine cache:', cacheRoot);
  const swept = [cacheRoot, engineCacheDir(app.getPath('userData'))].map((d) => sweepPartialEncodes(path.join(d, 'conform'))).reduce((a, b) => ({ files: a.files + b.files, bytes: a.bytes + b.bytes }));
  if (swept.files) console.log(`engine cache: removed ${swept.files} partial encode(s), ${(swept.bytes / 2 ** 30).toFixed(2)} GB`);
  let worker: BrowserWindow | null = null;
  let workerReady = false;
  let generation = 0;
  let restartCause: 'gpu-context-lost' | 'requested' | 'test' | undefined;

  // A-3: the long jobs (import, conform, cut detection) run in a crash-isolated utilityProcess. The
  // worker reaches it over its own MessagePort; when it dies, main tells the worker (which fails the
  // calls in flight), starts a new one and wires a fresh port.
  let jobs: UtilityProcess | null = null;
  let closing = false;
  const connectJobs = () => {
    if (!jobs || !worker || !workerReady) return;
    const { port1, port2 } = new MessageChannelMain();
    jobs.postMessage(null, [port1]);
    worker.webContents.postMessage('jobs:port', null, [port2]);
  };
  const spawnJobs = () => {
    const child = utilityProcess.fork(path.join(__dirname, 'jobs.cjs'), [], { serviceName: 'Moshpit jobs', stdio: 'inherit' });
    jobs = child;
    child.on('exit', (code) => {
      if (jobs !== child || closing) return;
      jobs = null;
      console.error(`job process exited (code ${code}); restarting it`);
      worker?.webContents.send('jobs:gone', { code });
      spawnJobs();
      connectJobs();
    });
  };
  spawnJobs();

  // Either side may be first: the worker finishing its load, or the UI's preload saying hello.
  const connect = () => {
    if (!worker || !workerReady || ui.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    worker.webContents.postMessage('engine:port', { generation }, [port2]);
    ui.webContents.postMessage('engine:port', { generation }, [port1]);
  };

  const spawn = () => {
    generation++;
    restartCause = undefined;
    workerReady = false;
    worker = new BrowserWindow({
      show: false, width: 320, height: 200,
      // Trusted local code only: the worker never loads remote content. It needs Node for the file
      // system and ffmpeg, so it is not sandboxed; the UI window is.
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, sandbox: false },
    });
    worker.webContents.on('render-process-gone', (_e, details) => {
      const crashed = worker;
      worker = null;
      const notice = { reason: details.reason, exitCode: details.exitCode, ...(restartCause ? { cause: restartCause } : {}) };
      recordWorkerCrash(app.getPath('userData'), { ...notice, generation, version: app.getVersion(), time: new Date().toISOString() });
      if (!ui.isDestroyed()) ui.webContents.send('engine:crashed', notice);
      crashed?.destroy();
      if (!ui.isDestroyed()) spawn();
    });
    worker.webContents.once('did-finish-load', () => { workerReady = true; connect(); connectJobs(); });
    void worker.loadURL(workerUrl({ cache: cacheRoot, library: libraryFromSettings() }));
  };

  // The UI asks for a fresh channel after a reload of its own.
  ipcMain.on('engine:hello', (e) => { if (e.sender === ui.webContents) connect(); });
  // Phase 0.3: the worker lost its WebGL context (a driver reset, a GPU hang). Its engines cannot
  // render again, so restart it: the crash path respawns, tells the UI, and the UI re-sends the project.
  ipcMain.on('engine:gpu-lost', (e) => {
    if (worker && e.sender === worker.webContents) {
      console.error('engine: WebGL context lost; restarting the worker');
      restartCause = 'gpu-context-lost';
      worker.webContents.forcefullyCrashRenderer();
    }
  });
  // Test hook only: lets the e2e harness prove crash isolation.
  if (process.env.MOSHPIT_TEST) ipcMain.handle('engine:test-crash', () => { restartCause = 'test'; worker?.webContents.forcefullyCrashRenderer(); });

  ui.on('closed', () => { closing = true; worker?.destroy(); worker = null; jobs?.kill(); jobs = null; });
  // A-1: the first worker starts once the UI page exists. Its page is generated in memory and would
  // otherwise load first and become the app's first window. Crash respawns are immediate.
  ui.webContents.once('dom-ready', spawn);
  return { restart: () => { restartCause = 'requested'; worker?.webContents.forcefullyCrashRenderer(); }, worker: () => worker };
}
