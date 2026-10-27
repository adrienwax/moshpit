// Main-process side of the project lifecycle (L12–L14). The engine's persistence API needs fs, so
// it runs here (INTERFACES.md): parseProject/saveProjectFile for open/save (migrations, schema
// versions, unknown fields kept verbatim, atomic writes), Autosaver for the per-edit journal, and
// recover() after a crash. The renderer owns the document (L24) and only ever sends snapshots.
//
//   project:open-dialog / save-dialog   native pickers → a path chosen by the user
//   project:load(path)                  { doc, warnings, migrated, recovery? }
//   project:save(path, doc)             atomic save + a fresh journal against it
//   project:session(path?, saved, cur)  start journaling (untitled → userData/recovery)
//   project:journal(doc)                one committed edit → one delta line
//   project:pending-recovery            journals left by a crash, newest first
//   project:discard-recovery(path?)     drop a crashed session's journal
//   app:close-requested → renderer;  app:close-now ← renderer   (unsaved-changes prompt)
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import { existsSync, promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadProjectFile, saveProjectFile } from '../../engine/src/project/io';
import { Autosaver, recover } from '../../engine/src/project/journal';
import type { ProjectDoc } from '@moshpit/engine';
import { mediaRootsOf, previewDir, rebaseCachePaths, settingsPaths } from './engine-cache';
import { projectSavePath, suggestedProjectFile } from '../src/lib/projectFiles';
import { installCloseRequestGate } from './close-request';

// Keep the private recovery slot stable across upgrades. Public Save As uses .mosh;
// renaming this internal slot would hide unsaved work left by earlier builds.
const EXT = '.moshpit.json';
const recoveryDir = () => path.join(app.getPath('userData'), 'recovery');
const untitledFile = () => path.join(recoveryDir(), `untitled${EXT}`);
const recentsFile = () => path.join(app.getPath('userData'), 'config', 'recents.json');

async function readRecents(): Promise<string[]> {
  try {
    return JSON.parse(await fs.readFile(recentsFile(), 'utf8'));
  } catch {
    return [];
  }
}
async function pushRecent(file: string) {
  const list = [file, ...(await readRecents()).filter((f) => f !== file)].slice(0, 10);
  await fs.mkdir(path.dirname(recentsFile()), { recursive: true });
  await fs.writeFile(recentsFile(), JSON.stringify(list, null, 2));
}

/** Errors cross IPC as MoshpitError JSON, never as a raw Error (L26). */
const wire = (e: unknown) => (e && typeof (e as { toJSON?: unknown }).toJSON === 'function' ? (e as { toJSON(): unknown }).toJSON() : { code: 'INTERNAL', humanMessage: 'Something inside Moshpit went wrong.', suggestedFix: 'Copy the error details for a bug report. Your project file is unchanged.', severity: 'fatal', context: {}, cause: String(e) });
async function guard<T>(fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: wire(e) };
  }
}

export function startProjectHost(win: BrowserWindow) {
  let saver: Autosaver | null = null;
  let sessionFile: string | null = null;
  let pendingUntitled = false;
  let allowClose = false;
  const requestClose = installCloseRequestGate(win);
  // Tests drive native dialogs through this (only with MOSHPIT_TEST set).
  const testPath = () => (process.env.MOSHPIT_TEST && process.env.MOSHPIT_DIALOG_PATH) || null;

  ipcMain.handle('project:open-dialog', async () => {
    if (testPath()) return testPath();
    const r = await dialog.showOpenDialog(win, { title: 'Open project', filters: [{ name: 'Moshpit project', extensions: ['mosh', 'json', 'moshpit'] }], properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('project:save-dialog', async (_e, suggested: string) => {
    if (testPath()) return testPath();
    const r = await dialog.showSaveDialog(win, { title: 'Save project', defaultPath: suggestedProjectFile(suggested), filters: [{ name: 'Moshpit project', extensions: ['mosh'] }] });
    if (r.canceled || !r.filePath) return null;
    const file = projectSavePath(r.filePath);
    // A typed legacy suffix can resolve to a different existing file. The picker
    // confirmed its original path, not this normalized destination.
    if (file !== r.filePath && existsSync(file)) {
      const replace = await dialog.showMessageBox(win, { type: 'warning', title: 'Replace project?', message: `Replace ${path.basename(file)}?`, detail: 'A project with this .mosh filename already exists.', buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0 });
      if (replace.response !== 1) return null;
    }
    return file;
  });

  ipcMain.handle('project:load', (_e, file: string) =>
    guard(async () => {
      const loaded = loadProjectFile(file);
      // A journal next to the file means the last session ended without saving or discarding.
      const rec = recover(file);
      await pushRecent(file);
      return {
        doc: rebaseCachePaths(loaded.doc, app.getPath('userData')),
        warnings: loaded.warnings.map((w) => w.toJSON()),
        migrated: loaded.migrated,
        recovery: rec && (rec.replayed > 0 || rec.tornTail) && !rec.stale ? { doc: rebaseCachePaths(rec.doc, app.getPath('userData')), replayed: rec.replayed, tornTail: rec.tornTail } : undefined,
      };
    }),
  );

  ipcMain.handle('project:save', (_e, file: string, doc: ProjectDoc) =>
    guard(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      if (sessionFile === file && saver) saver.save(doc);
      else {
        saveProjectFile(file, doc);
        // The untitled session's recovery data is obsolete once it has a real home.
        if (sessionFile === untitledFile()) rmSync(`${untitledFile()}.journal`, { force: true });
        rmSync(`${file}.journal`, { force: true });
        saver = new Autosaver(file, doc);
        sessionFile = file;
      }
      await pushRecent(file);
      return file;
    }),
  );

  /** Start journaling against `saved` (null file = untitled); `current` = a recovered doc to journal at once. */
  ipcMain.handle('project:session', (_e, file: string | null, saved: ProjectDoc, current: ProjectDoc | null) =>
    guard(async () => {
      const f = file ?? untitledFile();
      await fs.mkdir(path.dirname(f), { recursive: true });
      if (!file) {
        // "Not now" and recovering a different project must leave a crashed untitled session
        // recoverable. Copy both pieces before reusing its fixed slot; a failed copy aborts
        // setup, leaving the original intact. Active-session discards are not deferred work.
        if ((pendingUntitled || sessionFile !== f) && existsSync(f) && existsSync(`${f}.journal`)) {
          const previous = recover(f);
          // Save As copies can share an id, so only identical recovered content (apart from
          // the recovery label) consumes this slot. Different edits with the same id survive.
          const recoveringPrevious = previous && current && JSON.stringify({ ...previous.doc, name: current.name }) === JSON.stringify(current);
          if (previous && !previous.stale && previous.replayed > 0 && !recoveringPrevious) {
            const deferred = path.join(recoveryDir(), `deferred-${randomUUID()}${EXT}`);
            await fs.copyFile(f, deferred);
            await fs.copyFile(`${f}.journal`, `${deferred}.journal`);
          }
        }
        saveProjectFile(f, saved); // untitled: the journal needs a base file
        pendingUntitled = false;
      }
      rmSync(`${f}.journal`, { force: true });
      saver = new Autosaver(f, saved);
      sessionFile = f;
      if (current) saver.commit(current);
      return f;
    }),
  );

  ipcMain.on('project:journal', (_e, doc: ProjectDoc) => {
    try {
      saver?.commit(doc);
    } catch (e) {
      console.error('journal append failed:', e);
    }
  });

  ipcMain.handle('project:pending-recovery', () =>
    guard(async () => {
      const out: { file: string | null; doc: ProjectDoc; replayed: number; tornTail: boolean; name: string }[] = [];
      const deferred = existsSync(recoveryDir())
        ? (await fs.readdir(recoveryDir())).filter(f => /^deferred-[\da-f-]+\.moshpit\.json$/i.test(f)).map(f => path.join(recoveryDir(), f))
        : [];
      const candidates: (string | null)[] = [null, ...deferred, ...(await readRecents())];
      for (const c of candidates) {
        const f = c ?? untitledFile();
        if (!existsSync(f) || !existsSync(`${f}.journal`)) continue;
        try {
          const r = recover(f);
          if (r && !r.stale && r.replayed > 0) {
            if (c === null) pendingUntitled = true;
            out.push({ file: c, doc: rebaseCachePaths(r.doc, app.getPath('userData')), replayed: r.replayed, tornTail: r.tornTail, name: r.doc.name });
          }
        } catch {
          /* an unreadable base file is not recoverable; the open path reports it properly */
        }
      }
      return out;
    }),
  );

  ipcMain.handle('project:discard-recovery', (_e, file: string | null) => {
    rmSync(`${file ?? untitledFile()}.journal`, { force: true });
    return true;
  });

  ipcMain.handle('project:recents', async () => (await readRecents()).filter((f) => existsSync(f)));

  // HOME's project cards: a read-only summary. Unlike project:load it leaves recents and the
  // recovery journal alone, and it never throws: an unreadable file comes back as { error }.
  ipcMain.handle('project:peek', async (_e, file: string) => {
    try {
      const st = await fs.stat(file);
      const { doc } = loadProjectFile(file);
      const fps = doc.settings.fps.num / doc.settings.fps.den;
      const frames = doc.timeline.blocks.reduce((a, b) => a + Math.max(1, b.out - b.in) * Math.max(1, b.repeat), 0);
      const first = doc.timeline.blocks[0];
      const src = first && doc.resources.sources.find((s) => s.id === first.sourceId);
      const sfps = src ? src.probe.fps.num / src.probe.fps.den : fps;
      return {
        file, name: doc.name, mtimeMs: st.mtimeMs, bytes: st.size,
        blocks: doc.timeline.blocks.length, clips: doc.resources.sources.length,
        missing: doc.resources.sources.filter((s) => !existsSync(s.path)).length,
        seconds: frames / fps, bpm: doc.settings.bpm, fps,
        thumb: src && existsSync(src.path) ? { path: src.path, timeSec: first.in / sfps } : null,
      };
    } catch (e) {
      return { file, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // Export files. Absolute paths only: the renderer names folders the user typed, never relative ones.
  const absolute = (p: string) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`not an absolute path: ${p}`);
    return path.normalize(p);
  };
  ipcMain.handle('files:ensure-dir', async (_e, dir: string) => void (await fs.mkdir(absolute(dir), { recursive: true })));
  // F5 (UX round 2): the quick preview is one transient slot. Before a new one renders, the old
  // preview files go. Phase 0.4: main fixes the folder itself (previewDir) and takes no path from
  // the renderer, so this only ever touches preview_*.mp4 directly inside that one folder. A file
  // still open (the overlay playing it) is skipped; the next preview clears it.
  const previews = () => {
    const ud = app.getPath('userData'), p = settingsPaths(ud);
    return previewDir(ud, p.cache, mediaRootsOf(p.media, app.getPath('videos')));
  };
  ipcMain.handle('files:preview-dir', async () => {
    const d = previews();
    await fs.mkdir(d, { recursive: true });
    return d;
  });
  ipcMain.handle('files:clear-previews', async (_e, keep: string[] = []) => {
    const d = previews();
    if (!Array.isArray(keep) || !keep.every(p => typeof p === 'string')) throw new Error('invalid preview keep list');
    const retained = new Set(keep.map(p => path.resolve(p).toLowerCase()));
    if (!existsSync(d)) return 0;
    let n = 0;
    for (const f of await fs.readdir(d)) {
      if (!/^preview_.*\.mp4$/i.test(f)) continue;
      if (retained.has(path.resolve(d, f).toLowerCase())) continue;
      try { await fs.unlink(path.join(d, f)); n++; } catch { /* in use: next time */ }
    }
    return n;
  });
  ipcMain.handle('files:next-free', (_e, file: string, taken: string[] = []) => {
    const f = absolute(file);
    const busy = (p: string) => existsSync(p) || taken.includes(p);
    if (!busy(f)) return f;
    const ext = path.extname(f);
    const stem = f.slice(0, -ext.length || undefined).replace(/_v\d{2,}$/, '');
    for (let v = 2; v < 1000; v++) {
      const c = `${stem}_v${String(v).padStart(2, '0')}${ext}`;
      if (!busy(c)) return c;
    }
    throw new Error('no free version name');
  });
  ipcMain.handle('files:reveal', (_e, file: string) => shell.showItemInFolder(absolute(file)));
  // Settings folder rows: the native folder picker. Returns the chosen folder, or null on cancel.
  ipcMain.handle('files:pick-folder', async (_e, title: string, start?: string) => {
    const r = await dialog.showOpenDialog(win, {
      title: typeof title === 'string' ? title : 'Choose a folder',
      defaultPath: typeof start === 'string' && path.isAbsolute(start) && existsSync(start) ? start : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  // Phase 0.3: the UI window's renderer died (a crash, out of memory, a GPU reset that took it down).
  // Every edit is in the journal, so reload: the fresh page offers the journal as a recovery. A
  // crash loop (more than 3 in a minute) stops reloading and says how to get the work back.
  const crashes: number[] = [];
  let lastCrash: string | null = null;
  win.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    crashes.push(now);
    while (now - crashes[0] > 60_000) crashes.shift();
    console.error(`UI renderer gone: ${d.reason} (exit ${d.exitCode})`);
    if (crashes.length > 3) {
      allowClose = true;
      dialog.showErrorBox('Moshpit keeps crashing', `The window crashed ${crashes.length} times in a minute (${d.reason}). Your edits up to the crash are in the autosave journal: start Moshpit again and choose Recover.`);
      win.close();
      return;
    }
    lastCrash = d.reason;
    win.webContents.reload();
  });
  // The page asks once at boot, so the recovery dialog can say the window crashed (not "closed").
  ipcMain.handle('project:last-crash', () => {
    const r = lastCrash;
    lastCrash = null;
    return r;
  });
  win.webContents.on('unresponsive', async () => {
    const r = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Moshpit is not responding', message: 'The window is not responding.',
      detail: 'Every edit is in the autosave journal, so reloading keeps your work: you will be offered to recover it.',
      buttons: ['Wait', 'Reload window'], defaultId: 0, cancelId: 0,
    });
    if (r.response === 1 && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer(); // the crash path reloads
  });

  // Closing with unsaved edits: the renderer decides (Save / Don't save / Cancel), then says so.
  // A dead renderer cannot answer, so its window closes (the journal keeps the edits).
  win.on('close', (e) => {
    if (allowClose || process.env.MOSHPIT_NO_CLOSE_PROMPT || win.webContents.isCrashed()) return;
    e.preventDefault();
    requestClose();
  });
  ipcMain.handle('app:close-now', (_e, discardJournal: boolean) => {
    if (discardJournal && sessionFile) {
      rmSync(`${sessionFile}.journal`, { force: true });
      // The untitled base file only exists to anchor its journal.
      if (sessionFile === untitledFile()) rmSync(sessionFile, { force: true });
    }
    allowClose = true;
    win.close();
  });
}
