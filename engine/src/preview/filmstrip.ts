// Raw-file preview fallback: evenly spaced JPEG stills from ffmpeg, for any file ffmpeg reads.
// The source browser shows these for formats WebCodecs cannot decode (preview/probe.ts says
// which), and can use them as thumbnails for every clip. One input-seek per cell (73–563 ms each
// on real files, BUILD-LOG 7 Oct), four at a time, cached on disk: a second look costs a read.
// The cache keys on path + size + mtime, as v1's filmstrip cache did (electron/main.js).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MoshpitError } from '../errors';
import { findFfmpeg, run } from '../conform/ffmpeg';
import { probe } from '../conform/conform';

export interface FilmstripCell {
  /** Seconds into the file. */
  time: number;
  jpeg: Uint8Array;
}

export interface Filmstrip {
  durationSec: number;
  width: number;
  cells: FilmstripCell[];
}

export interface FilmstripOptions {
  /** Number of stills, evenly spaced, each at the middle of its slice. Default 16. */
  count?: number;
  /** Still width in pixels; height follows the display aspect. Default 160. */
  width?: number;
  ffmpeg?: string;
  signal?: AbortSignal;
}

export async function filmstrip(file: string, cacheDir: string, o: FilmstripOptions = {}): Promise<Filmstrip> {
  const count = Math.max(1, Math.min(256, Math.round(o.count ?? 16)));
  const width = Math.max(16, Math.min(1920, Math.round(o.width ?? 160)));
  if (!fs.existsSync(file)) throw new MoshpitError('MEDIA_FILE_MISSING', { path: file });
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}|${count}|${width}`).digest('hex');
  const dir = path.join(cacheDir, 'filmstrips', key);
  const index = path.join(dir, 'index.json');
  if (fs.existsSync(index)) {
    try {
      const meta = JSON.parse(fs.readFileSync(index, 'utf8')) as { durationSec: number; times: number[] };
      return { durationSec: meta.durationSec, width, cells: meta.times.map((time, i) => ({ time, jpeg: new Uint8Array(fs.readFileSync(path.join(dir, `${i}.jpg`))) })) };
    } catch { /* a damaged cache entry: build it again */ }
  }
  const p = await probe(file, o.ffmpeg);
  const { ffmpeg, ffprobe } = findFfmpeg(o.ffmpeg);
  // -ss counts from the file's start time, and the container's duration includes it (an MPEG-PS
  // starting at 0.53 s claims 3.0 s and holds 2.47 s): space the stills over what is really there.
  const start = parseFloat((await run(ffprobe, ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', file])).stdout) || 0;
  const span = Math.max(0.04, p.durationSec - Math.max(0, start));
  const times = Array.from({ length: count }, (_, i) => +(((i + 0.5) / count) * span).toFixed(3));
  const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const one = async (i: number) => {
      // -ss before -i: a keyframe seek then decode to the time. ffmpeg applies the rotation tag itself.
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-ss', String(times[i]), '-i', file, '-frames:v', '1', '-an',
        '-vf', `scale=${width}:-2:out_range=full,format=yuvj420p`, '-q:v', '4', '-y', path.join(tmp, `${i}.jpg`)];
      // A seek past the last decodable frame writes nothing (a container can claim more than the
      // stream holds, e.g. an MPEG-PS starting at 0.53 s): walk back until a frame comes out.
      for (const t of [times[i], (i / count) * span, times[i] / 2, 0]) {
        args[args.indexOf('-ss') + 1] = String(t);
        await run(ffmpeg, args, { signal: o.signal });
        if (fs.existsSync(path.join(tmp, `${i}.jpg`))) { times[i] = t; return; }
      }
      throw new MoshpitError('MEDIA_UNREADABLE', { path: file, why: 'filmstrip: no frame decodes' });
    };
    for (let i = 0; i < count; i += 4) await Promise.all(Array.from({ length: Math.min(4, count - i) }, (_, k) => one(i + k)));
    fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify({ durationSec: span, times }));
    fs.rmSync(dir, { recursive: true, force: true });
    try { fs.renameSync(tmp, dir); } catch { /* another process won the race: its copy is the same */ }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if ((e as Error)?.name === 'AbortError') throw e;
    throw e instanceof MoshpitError ? e : new MoshpitError('MEDIA_UNREADABLE', { path: file, why: 'filmstrip', stderr: (e as { stderr?: string }).stderr?.slice(-1000) }, e);
  }
  const from = fs.existsSync(index) ? dir : tmp;
  return { durationSec: span, width, cells: times.map((time, i) => ({ time, jpeg: new Uint8Array(fs.readFileSync(path.join(from, `${i}.jpg`))) })) };
}
