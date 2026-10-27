import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { MoshpitError } from '@moshpit/core';
import { LOOK_EXTENSION, lookProblem, parsePortableLook } from '../../engine/src/project/lookIO';
import { readLookFile, writeLookFile } from './look-files';

export function startLookHost(win: BrowserWindow) {
  const guard = async <T>(sender: Electron.WebContents, fn: () => Promise<T>) => {
    try {
      if (sender !== win.webContents) lookProblem('This look request came from an inactive window.');
      return { ok: true, value: await fn() };
    } catch (error) {
      const e = error instanceof MoshpitError ? error : new MoshpitError('RECIPE_INVALID', {}, error, 'The look file could not be read or saved. Check the selected folder and file permissions, then retry.');
      return { ok: false, error: e.toJSON() };
    }
  };
  ipcMain.handle('look:import', e => guard(e.sender, async () => {
    const picked = await dialog.showOpenDialog(win, { title: 'Import look into this project', filters: [{ name: 'Moshpit look', extensions: ['json'] }], properties: ['openFile'] });
    return picked.canceled || !picked.filePaths[0] ? null : readLookFile(picked.filePaths[0]);
  }));
  ipcMain.handle('look:export', (e, text: string) => guard(e.sender, async () => {
    const look = parsePortableLook(text);
    const picked = await dialog.showSaveDialog(win, {
      title: 'Export saved look', defaultPath: look.name.replace(/[\\/:*?"<>|]+/g, '_') + LOOK_EXTENSION,
      filters: [{ name: 'Moshpit look (.moshlook.json)', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    await writeLookFile(picked.filePath, text);
    return picked.filePath;
  }));
}
