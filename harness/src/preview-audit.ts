// Raw-preview audit (Phase C gate, beside preview.ts): the three things preview.ts does not cover.
//   A1 decoders never leak: open / LRU-evict / close / dispose, counted on the real WebCodecs class
//   A2 VFR: exact frames land on the true frame across a frame-rate change
//   A3 scrub latency per format at 1080p on real footage (H.264 MP4 + MKV, HEVC, VP9 WebM, AV1)
// 1080p media is encoded once from the spike's GoPro clip into out/preview-audit (not fixtures/).
//   npm run build && electron harness/main.cjs preview-audit

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcRenderer } from 'electron';
import { EngineService } from '../../engine/src/service/service';
import { findFfmpeg } from '../../engine/src/conform/ffmpeg';
import { MoshpitError } from '../../engine/src/errors';
import { ROOT } from './fixtures';
import type { TestResult } from './gate';

const log = (m: string) => ipcRenderer.send('log', m);
const DIR = path.join(ROOT, 'out', 'preview-audit');
const MEDIA = path.join(DIR, 'media');
const GOPRO = process.env.MOSHPIT_REAL_FOOTAGE
  ? path.join(process.env.MOSHPIT_REAL_FOOTAGE, 'gopro-uw-1080p.mp4')
  : path.join(ROOT, '..', 'moshpit-v3-spike', 'fixtures-real', 'gopro-uw-1080p.mp4');

// ---------- decoder accounting: wrap the real class before anything constructs one ----------
const made: VideoDecoder[] = [];
const Real = globalThis.VideoDecoder;
class Counted extends Real {
  constructor(init: VideoDecoderInit) {
    super(init);
    made.push(this);
  }
}
(globalThis as { VideoDecoder: typeof VideoDecoder }).VideoDecoder = Counted as unknown as typeof VideoDecoder;
const live = () => made.filter((d) => d.state !== 'closed').length;
const tick = () => new Promise((r) => setTimeout(r, 50));

/** 1080p versions of the native formats, cut from the GoPro clip (12 s, a keyframe every 2 s). */
function media(): Record<string, string> {
  fs.mkdirSync(MEDIA, { recursive: true });
  const ff = findFfmpeg().ffmpeg;
  const cut = ['-ss', '20', '-t', '12', '-i', GOPRO, '-an', '-vf', 'scale=1920:1080', '-g', '60'];
  const jobs: Record<string, string[]> = {
    'h264.mp4': [...cut, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'],
    'h264.mkv': [...cut, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'],
    'hevc.mp4': [...cut, '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '24', '-tag:v', 'hvc1'],
    'vp9.webm': [...cut, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '6M'],
    'av1.mp4': [...cut, '-c:v', 'libsvtav1', '-preset', '12', '-crf', '35'],
    // No WebCodecs decoder: these take the ffmpeg filmstrip path.
    'prores.mov': [...cut, '-c:v', 'prores_ks', '-profile:v', '2'],
    'mpeg2.mpg': [...cut, '-c:v', 'mpeg2video', '-q:v', '3'],
    // VFR: 30 fps for the first 3 s, then every other frame dropped (15 fps) — real variable timing.
    'vfr.mp4': ['-ss', '20', '-t', '6', '-i', GOPRO, '-an', '-vf', "scale=1920:1080,select='lt(t\\,3)+mod(n\\,2)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60'],
  };
  const out: Record<string, string> = {};
  for (const [name, args] of Object.entries(jobs)) {
    const f = path.join(MEDIA, name);
    if (!fs.existsSync(f)) {
      const r = spawnSync(ff, ['-v', 'error', '-y', ...args, f], { maxBuffer: 16 << 20 });
      if (r.status !== 0) throw new Error(`encode ${name}: ${String(r.stderr)}`);
    }
    out[name] = f;
  }
  return out;
}

/** Every frame's presentation time, from ffprobe: the ground truth an exact preview must land on. */
function frameTimes(file: string): number[] {
  const ffprobe = findFfmpeg().ffprobe;
  const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file], { maxBuffer: 16 << 20 });
  return String(r.stdout).split(/\r?\n/).map((l) => parseFloat(l)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

export async function runPreviewAudit(): Promise<{ tests: TestResult[]; notes: string[] }> {
  const tests: TestResult[] = [];
  const notes: string[] = [];
  const check = async (id: string, name: string, fn: () => Promise<{ pass: boolean; evidence: string }>) => {
    try { tests.push({ id, name, ...(await fn()) }); } catch (e) { tests.push({ id, name, pass: false, evidence: `threw: ${e instanceof MoshpitError ? JSON.stringify(e.toJSON()) : (e as Error)?.stack ?? e}` }); }
    const r = tests[tests.length - 1];
    log(`[preview-audit] ${r.pass ? 'PASS' : 'FAIL'} ${id} ${r.evidence.slice(0, 400)}`);
  };
  if (!fs.existsSync(GOPRO)) throw new Error(`real footage not found: ${GOPRO} (set MOSHPIT_REAL_FOOTAGE)`);
  const t0 = Date.now();
  const files = media();
  log(`[preview-audit] media ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const svc = new EngineService({ cacheDir: path.join(DIR, 'cache') });
  const size = { w: 640, h: 360 };
  const native = ['h264.mp4', 'h264.mkv', 'hevc.mp4', 'vp9.webm', 'av1.mp4', 'vfr.mp4'];

  await check('A1', 'no leaked decoders: probe opens none, the LRU caps open ones, close and dispose release all', async () => {
    const base = live();
    for (const n of native) await svc.previewInfo(files[n]);
    const afterInfo = live() - base;
    let peak = 0;
    for (const n of native) {
      await svc.previewFrame(files[n], 4.2, { size });
      await svc.previewFrame(files[n], 4.2, { size, exact: true });
      peak = Math.max(peak, live() - base);
    }
    // LRU: at most 4 open files, two decoders (snap + exact) each.
    for (const n of native) svc.closePreview(files[n]);
    await tick();
    const afterClose = live() - base;
    // Reopen two, then dispose the whole service.
    await svc.previewFrame(files['h264.mp4'], 1, { size });
    await svc.previewFrame(files['vp9.webm'], 1, { size, exact: true });
    const reopened = live() - base;
    svc.dispose();
    await tick();
    const afterDispose = live() - base;
    const pass = afterInfo === 0 && peak <= 8 && afterClose === 0 && reopened > 0 && afterDispose === 0;
    return { pass, evidence: `decoders created ${made.length}; live after previewInfo ×${native.length}: ${afterInfo}; peak while scrubbing ${native.length} files: ${peak} (cap 4 files × 2); after closePreview all: ${afterClose}; reopened 2: ${reopened}; after dispose: ${afterDispose}` };
  });

  const svc2 = new EngineService({ cacheDir: path.join(DIR, 'cache') });
  await check('A2', 'VFR: exact frames land on the true frame on both sides of a 30 → 15 fps change', async () => {
    const f = files['vfr.mp4'];
    const truth = frameTimes(f);
    const want = (t: number) => truth.filter((x) => x <= t + 1e-6).at(-1)!;
    const out: string[] = [];
    let ok = true;
    for (const t of [0.5, 1.7, 2.95, 3.3, 4.1, 5.5]) {
      const r = (await svc2.previewFrame(f, t, { size, exact: true }))!;
      const good = r.exact && Math.abs(r.time - want(t)) < 2e-3;
      ok &&= good;
      out.push(`t ${t}: ${r.time.toFixed(4)} (true ${want(t).toFixed(4)})${good ? '' : ' ✗'}`);
    }
    const gaps = truth.slice(1).map((x, i) => x - truth[i]);
    return { pass: ok, evidence: `frame gaps ${Math.min(...gaps).toFixed(4)}–${Math.max(...gaps).toFixed(4)} s; ${out.join('; ')}` };
  });

  await check('A3', 'scrub latency per format, 1080p real footage, 640×360 frames (open, 5 cold keyframe snaps, 20 exact seeks)', async () => {
    const rows: string[] = [];
    let ok = true;
    for (const n of native.filter((x) => x !== 'vfr.mp4')) {
      const f = files[n];
      const info = await svc2.previewInfo(f);
      const o0 = performance.now();
      await svc2.previewFrame(f, 0.1, { size });
      const open = performance.now() - o0;
      // Cold snaps only: one per keyframe (every 2 s), never repeated, so none comes from the cache.
      const snap: number[] = [], exact: number[] = [];
      for (const k of [10, 4, 8, 2, 6]) {
        const s = performance.now();
        await svc2.previewFrame(f, k + 0.9, { size });
        snap.push(performance.now() - s);
      }
      // Exact: 20 distinct positions, each a fresh decode run from its keyframe.
      for (let i = 0; i < 20; i++) {
        const s = performance.now();
        await svc2.previewFrame(f, 0.2 + ((i * 7.31) % 11.5) + 0.013 * i, { size, exact: true });
        exact.push(performance.now() - s);
      }
      svc2.closePreview(f);
      // Interactive bar: a hover snap answers within a frame or two at 60 Hz on the median.
      ok &&= info.mode === 'native' && pct(snap, 0.5) < 50;
      rows.push(`${n} (${info.container}/${info.codec} ${info.width}×${info.height}): open ${open.toFixed(0)} ms · cold snap median ${pct(snap, 0.5).toFixed(0)} / max ${Math.max(...snap).toFixed(0)} ms · exact median ${pct(exact, 0.5).toFixed(0)} / p90 ${pct(exact, 0.9).toFixed(0)} / max ${Math.max(...exact).toFixed(0)} ms`);
    }
    notes.push(...rows);
    return { pass: ok, evidence: rows.join(' | ') };
  });
  await check('A4', 'filmstrip fallback, 1080p: which formats take it, and how long a 12-still strip takes cold and cached', async () => {
    const rows: string[] = [];
    let ok = true;
    for (const n of ['prores.mov', 'mpeg2.mpg']) {
      const f = files[n];
      const info = await svc2.previewInfo(f);
      fs.rmSync(path.join(DIR, 'cache', 'filmstrips'), { recursive: true, force: true });
      let s = performance.now();
      const cold = await svc2.filmstrip(f, { count: 12, width: 320 });
      const coldMs = performance.now() - s;
      s = performance.now();
      await svc2.filmstrip(f, { count: 12, width: 320 });
      const warmMs = performance.now() - s;
      ok &&= info.mode === 'filmstrip' && cold.cells.length === 12;
      rows.push(`${n} (${info.container}/${info.codec}) → ${info.mode}${info.reason ? ` (${info.reason})` : ''}: 12 stills cold ${coldMs.toFixed(0)} ms (${(coldMs / 12).toFixed(0)} ms/still), cached ${warmMs.toFixed(0)} ms`);
    }
    notes.push(...rows);
    return { pass: ok, evidence: rows.join(' | ') };
  });
  svc2.dispose();
  return { tests, notes };
}
