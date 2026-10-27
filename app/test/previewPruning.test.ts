import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const ipc = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('electron', () => ({ app: { getPath: () => ipc.root }, dialog: {}, shell: {}, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => ipc.handlers.set(name, fn), on: vi.fn() } }));
import { startProjectHost } from '../electron/project-host';
const call = (name: string, ...args: unknown[]) => ipc.handlers.get(name)!({}, ...args);
beforeEach(() => {
  ipc.root = fs.mkdtempSync(path.join(os.tmpdir(), 'moshpit-preview-prune-'));
  ipc.handlers.clear();
  startProjectHost({ webContents: { on: vi.fn() }, on: vi.fn(), once: vi.fn() } as never);
});
afterEach(() => { fs.rmSync(ipc.root, { recursive: true, force: true }); });

it('retains history and pending previews while pruning only obsolete preview MP4s in the fixed cache', async () => {
  const dir = await call('files:preview-dir');
  const keep = path.join(dir, 'preview_keep.mp4'), pending = path.join(dir, 'preview_pending.mp4');
  for (const name of ['preview_keep.mp4', 'preview_pending.mp4', 'preview_old.mp4', 'source.mp4', 'preview_notes.txt']) fs.writeFileSync(path.join(dir, name), 'test');
  const outside = path.join(ipc.root, 'preview_outside.mp4'); fs.writeFileSync(outside, 'source');
  const nested = path.join(dir, 'nested'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, 'preview_nested.mp4'), 'source');
  expect(await call('files:clear-previews', [keep, pending])).toBe(1);
  expect(fs.readdirSync(dir).sort()).toEqual(['nested', 'preview_keep.mp4', 'preview_notes.txt', 'preview_pending.mp4', 'source.mp4']);
  expect(fs.readFileSync(outside, 'utf8')).toBe('source');
  expect(fs.existsSync(path.join(nested, 'preview_nested.mp4'))).toBe(true);
});

it('rejects malformed retention input before touching files', async () => {
  const dir = await call('files:preview-dir');
  const file = path.join(dir, 'preview_saved.mp4'); fs.writeFileSync(file, 'keep');
  await expect(call('files:clear-previews', [null])).rejects.toThrow('invalid preview keep list');
  expect(fs.readFileSync(file, 'utf8')).toBe('keep');
});
