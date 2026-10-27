// The only bridge the renderer gets. Mirrors `HostBridge` in src/host.ts.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { CommandOptions, ControlFeedback } from '@moshpit/core';

// Engine lane: relay the worker's MessagePort (and crash notices) into the page; say hello so a
// port posted before this window finished loading is re-sent.
ipcRenderer.on('engine:port', (e) => window.postMessage('moshpit-engine-port', '*', e.ports));
ipcRenderer.on('engine:crashed', (_e, d: { reason: string; exitCode?: number; cause?: string }) => window.postMessage({ type: 'moshpit-engine-crashed', reason: d.reason, exitCode: d.exitCode, cause: d.cause }, '*'));
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('engine:hello'));
contextBridge.exposeInMainWorld('moshpitEngine', { available: true });
// Engine lane: the CT control bridge (control-host.ts). The UI store publishes after each committed
// edit and applies forwarded CT writes and commands as its own undoable edits.
contextBridge.exposeInMainWorld('moshpitControl', {
  hostStatus: () => ipcRenderer.invoke('control:status'),
  onHostStatus: (fn: (status: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, status: unknown) => fn(status);
    ipcRenderer.on('control:status-changed', listener);
    return () => ipcRenderer.removeListener('control:status-changed', listener);
  },
  publish: (doc: unknown, generation: number) => ipcRenderer.send('control:doc', { doc, generation }),
  workspace: (workspace: string) => ipcRenderer.send('control:workspace', workspace),
  feedback: (feedback: ControlFeedback) => ipcRenderer.send('control:feedback', feedback),
  onCommit: (fn: (m: { path: string; value: unknown }) => void) => ipcRenderer.on('control:commit', (_e, m) => fn(m)),
  onWrite: (fn: (m: unknown) => void) => ipcRenderer.on('control:write', (_e, m) => fn(m)),
  reply: (m: unknown) => ipcRenderer.send('control:result', m),
  onCommand: (fn: (m: { command: string } & CommandOptions) => void) => ipcRenderer.on('control:command', (_e, m) => fn(m)),
  onClients: (fn: (count: number) => void) => ipcRenderer.on('control:clients', (_e, n) => fn(n)),
  onSelect: (fn: (m: { nodeId: string }) => void) => ipcRenderer.on('control:select', (_e, m) => fn(m)),
});

contextBridge.exposeInMainWorld('moshpitHost', {
  // A dropped file's real path (Electron 43 removed File.path; webUtils is the replacement).
  pathOf: (file: File) => webUtils.getPathForFile(file),
  testClipsDir: process.env.MOSHPIT_TEST_CLIPS,
  readConfig: (name: string) => ipcRenderer.invoke('config:read', name),
  writeConfig: (name: string, data: unknown) => ipcRenderer.invoke('config:write', name, data),
  looks: {
    import: () => ipcRenderer.invoke('look:import'),
    export: (text: string) => ipcRenderer.invoke('look:export', text),
  },
  files: {
    ensureDir: (dir: string) => ipcRenderer.invoke('files:ensure-dir', dir),
    nextFree: (file: string, taken: string[]) => ipcRenderer.invoke('files:next-free', file, taken),
    previewDir: () => ipcRenderer.invoke('files:preview-dir'),
    clearPreviews: (keep: string[] = []) => ipcRenderer.invoke('files:clear-previews', keep),
    reveal: (file: string) => ipcRenderer.invoke('files:reveal', file),
    pickFolder: (title: string, start?: string) => ipcRenderer.invoke('files:pick-folder', title, start),
  },
  // Project lifecycle (project-host.ts). Mirrors `ProjectBridge` in src/host.ts.
  project: {
    openDialog: () => ipcRenderer.invoke('project:open-dialog'),
    saveDialog: (suggested: string) => ipcRenderer.invoke('project:save-dialog', suggested),
    load: (file: string) => ipcRenderer.invoke('project:load', file),
    save: (file: string, doc: unknown) => ipcRenderer.invoke('project:save', file, doc),
    session: (file: string | null, saved: unknown, current: unknown) => ipcRenderer.invoke('project:session', file, saved, current),
    journal: (doc: unknown) => ipcRenderer.send('project:journal', doc),
    pendingRecovery: () => ipcRenderer.invoke('project:pending-recovery'),
    discardRecovery: (file: string | null) => ipcRenderer.invoke('project:discard-recovery', file),
    lastCrash: () => ipcRenderer.invoke('project:last-crash'),
    recents: () => ipcRenderer.invoke('project:recents'),
    peek: (file: string) => ipcRenderer.invoke('project:peek', file),
    onCloseRequested: (fn: () => void) => ipcRenderer.on('app:close-requested', () => fn()),
    readyForClose: () => ipcRenderer.send('app:close-ready'),
    onOpenRequested: (fn: (file: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, file: string) => fn(file);
      ipcRenderer.on('project:open-requested', listener);
      return () => ipcRenderer.removeListener('project:open-requested', listener);
    },
    readyForOpen: () => ipcRenderer.send('project:open-ready'),
    closeNow: (discardJournal: boolean) => ipcRenderer.invoke('app:close-now', discardJournal),
  },
});
