// Locating and running the bundled ffmpeg. An external executable (GPL build, not linked:
// audit S11), invoked from structured argument arrays only — never a shell string (L19).

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MoshpitError } from '../errors';

/**
 * Search order: explicit setting, MOSHPIT_FFMPEG, then PATH.
 * Packaging requires a separately reviewed build with the codecs the app exposes.
 */
export function findFfmpeg(explicit?: string): { ffmpeg: string; ffprobe: string } {
  const candidates = [explicit, process.env.MOSHPIT_FFMPEG].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { ffmpeg: c, ffprobe: path.join(path.dirname(c), path.basename(c).replace(/ffmpeg/i, 'ffprobe')) };
  }
  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
}

export interface RunResult { stdout: string; stderr: string }

export function run(bin: string, args: string[], opts: { onStderr?: (line: string) => void; signal?: AbortSignal; background?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(bin, args, { windowsHide: true, signal: opts.signal }); } catch (e) { reject(new MoshpitError('CONFORM_FFMPEG_MISSING', { bin }, e)); return; }
    // Scheduling only: priority never changes what x264 writes (threads are pinned in the args).
    if (opts.background && p.pid) try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    let stdout = '', stderr = '', partial = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => {
      const s = String(d);
      stderr = (stderr + s).slice(-64 * 1024);
      if (opts.onStderr) { partial += s; const lines = partial.split(/\r|\n/); partial = lines.pop() ?? ''; for (const l of lines) if (l) opts.onStderr(l); }
    });
    p.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new MoshpitError('CONFORM_FFMPEG_MISSING', { bin }, e) : e));
    p.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(`${path.basename(bin)} exited ${code}`), { stderr }))));
  });
}

export function ffmpegVersion(ffmpeg: string): Promise<string> {
  return new Promise((resolve) => execFile(ffmpeg, ['-hide_banner', '-version'], { windowsHide: true }, (e, out) => resolve(e ? 'unknown' : String(out).split('\n')[0].trim())));
}
