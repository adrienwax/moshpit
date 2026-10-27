// Main-process side of CT Route B (engine lane): runs the control server from CONTROL-PROTOCOL.md
// and bridges it to the UI's project store, which stays the only source of truth (L24).
//
//   UI → main   'control:doc'      { doc, generation }   after every committed edit
//   main → UI   'control:commit'   { path, value }       a CT write, to apply as an undoable edit
//   main → UI   'control:command'  { command }           a discrete command (C3)
//   main → UI   'control:select'   { nodeId }            the CT picked a slot: select it in the inspector (M1)
//
// Optional: MOSHPIT_CONTROL=0 turns it off; Moshpit runs fully without it (R6).

import { app, ipcMain, type BrowserWindow } from 'electron';
import path from 'node:path';
import { startControlServer, type ControlServer } from '../../engine/src/control/server';
import { isControlWorkspace, type ControlWorkspace } from '../../engine/src/control/hub';
import { newProject } from '../../engine/src/project/build';
import { changedControlValues, discoveryShape } from '../../engine/src/control/discovery';
import { parseControlFeedback, type ControlFeedback, type CommandId, type CommandOptions, type ParamValue, type ProjectDoc } from '@moshpit/core';
import { ControlRequests, type WriteReply } from './control-requests';

/**
 * `throttle`: the window's own backgroundThrottling. While a client is connected it is turned off,
 * so feedback keeps flowing with Moshpit minimised or behind another app (the CT drives it from
 * there: Route B). It is restored when the last client leaves.
 */
export async function startControlHost(ui: BrowserWindow, opts: { throttle: boolean } = { throttle: true }): Promise<ControlServer | null> {
  if (process.env.MOSHPIT_CONTROL === '0') return null;
  let doc: ProjectDoc = newProject('(no project yet)');
  let generation = 0;
  let workspace: ControlWorkspace = 'home';
  let feedback: ControlFeedback = { workspace, values: {} };
  let structure = '';
  const requests = new ControlRequests((m) => {
    if (ui.isDestroyed() || ui.webContents.isDestroyed()) throw new Error('control window is unavailable');
    ui.webContents.send('control:write', m);
  });
  const server = await startControlServer({
    snapshot: () => ({ doc, generation, workspace, feedback }),
    commit: (p: string, value: ParamValue) => { if (!ui.isDestroyed()) ui.webContents.send('control:commit', { path: p, value }); },
    write: (write) => requests.write(write, doc.id),
    command: (command: CommandId, options?: CommandOptions) => { if (!ui.isDestroyed()) ui.webContents.send('control:command', { command, ...options }); },
    select: (nodeId: string) => { if (!ui.isDestroyed()) ui.webContents.send('control:select', { nodeId }); },
    sessions: (count: number) => {
      if (ui.isDestroyed()) return;
      ui.webContents.setBackgroundThrottling(opts.throttle && count === 0);
      ui.webContents.send('control:clients', count);
    },
  }, { endpointFile: path.join(app.getPath('userData'), 'control-endpoint.json') });

  const onReply = (e: Electron.IpcMainEvent, reply: WriteReply) => {
    if (e.sender === ui.webContents) requests.reply(reply);
  };
  ipcMain.on('control:result', onReply);
  const onWorkspace = (e: Electron.IpcMainEvent, value: unknown) => {
    if (e.sender !== ui.webContents || !isControlWorkspace(value)) return;
    workspace = value;
    if (feedback.workspace !== workspace) { feedback = { workspace, values: {} }; server.hub.feedbackChanged(); }
    server.hub.workspaceChanged();
  };
  ipcMain.on('control:workspace', onWorkspace);
  ui.once('closed', () => ipcMain.removeListener('control:workspace', onWorkspace));
  const onFeedback = (e: Electron.IpcMainEvent, value: unknown) => {
    if (e.sender !== ui.webContents) return;
    const next = parseControlFeedback(value);
    if (!next || next.workspace !== workspace) return;
    feedback = next;
    server.hub.feedbackChanged();
  };
  ipcMain.on('control:feedback', onFeedback);
  ui.once('closed', () => ipcMain.removeListener('control:feedback', onFeedback));
  const clearFeedback = () => { feedback = { workspace, values: {} }; server.hub.feedbackChanged(); };
  ui.webContents.on('render-process-gone', () => { requests.close(); clearFeedback(); });
  ui.webContents.on('did-start-loading', clearFeedback);
  ui.once('closed', () => { requests.close(); ipcMain.removeListener('control:result', onReply); });

  ipcMain.on('control:doc', (e, msg: { doc: ProjectDoc; generation: number }) => {
    if (e.sender !== ui.webContents) return;
    requests.resume();
    const prev = doc;
    doc = msg.doc; generation = msg.generation;
    server.hub.selectionChanged(); // M1: one selection for the inspector and the CT
    // Graph shape or active block changed → clients re-discover; a value changed → throttled push.
    const shape = discoveryShape(doc);
    if (shape !== structure) { structure = shape; server.hub.structureChanged(); return; }
    for (const target of changedControlValues(prev, doc, generation)) {
      const { min, max } = target.param;
      server.hub.changed(target.path, target.value, undefined, min !== undefined && max !== undefined ? max - min : null);
    }
  });
  app.on('before-quit', () => { requests.close(); void server.close(); });
  return server;
}
