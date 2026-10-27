// Raw-file preview (engine/src/preview) on real WebCodecs: what Node cannot test. Capability per
// format, snap vs exact landing, exact pixels against an ffmpeg reference, rotation, latest-wins
// under a hover burst, the frame cache, and the contract that matters most: previewing raw files
// beside an export leaves the export byte-identical ("one decoder, two modes").

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcRenderer } from 'electron';
import { EngineService } from '../../engine/src/service/service';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { findFfmpeg } from '../../engine/src/conform/ffmpeg';
import { MoshpitError } from '../../engine/src/errors';
import type { ProjectDoc } from '../../engine/src/model';
import { OUT, ROOT } from './fixtures';
import type { TestResult } from './gate';

const log = (m: string) => ipcRenderer.send('log', m);
const DIR = path.join(OUT, 'preview');
const FX = (n: string) => path.join(ROOT, 'fixtures', n);

/** ffmpeg's decode of the frame at `time`, scaled to w×h, as RGBA: the reference. */
// BT.709: Chromium decodes untagged video as BT.709 (ffmpeg's default would be BT.601, a steady
// ~10/255 off). It is also what the conform writes, so a preview shows the colours an import gets.
function reference(file: string, time: number, w: number, h: number, matrix = 'bt709'): Uint8Array {
  const r = spawnSync(findFfmpeg().ffmpeg, ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=bilinear:in_color_matrix=${matrix}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 << 20 });
  return new Uint8Array(r.stdout as Buffer);
}
const meanDiff = (a: Uint8Array, b: Uint8Array) => { let d = 0, n = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { if ((i & 3) === 3) continue; d += Math.abs(a[i] - b[i]); n++; } return a.length === b.length ? d / n : Infinity; };
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

export async function runPreview(): Promise<{ tests: TestResult[]; notes: string[] }> {
  fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
  const tests: TestResult[] = [];
  const notes: string[] = [];
  const check = async (id: string, name: string, fn: () => Promise<{ pass: boolean; evidence: string }>) => {
    try { tests.push({ id, name, ...(await fn()) }); } catch (e) { tests.push({ id, name, pass: false, evidence: `threw: ${e instanceof MoshpitError ? JSON.stringify(e.toJSON()) : (e as Error)?.stack ?? e}` }); }
    const r = tests[tests.length - 1];
    log(`[preview] ${r.pass ? 'PASS' : 'FAIL'} ${id} ${r.evidence.slice(0, 300)}`);
  };
  const svc = new EngineService({ cacheDir: path.join(DIR, 'cache') });
  const NATIVE = ['src-a.mp4', 'pv-h264.mkv', 'pv-vp9.webm', 'pv-hevc.mp4', 'pv-av1.mp4', 'pv-rot90.mp4'];
  const FALLBACK = ['pv-prores.mov', 'pv-mpeg2.mpg', 'pv-mjpeg.avi'];

  await check('P1', 'capability on this machine: WebCodecs formats are native, the rest filmstrip', async () => {
    const rows = await Promise.all([...NATIVE, ...FALLBACK].map(async (n) => ({ n, i: await svc.previewInfo(FX(n)) })));
    const pass = rows.every(({ n, i }) => (NATIVE.includes(n) ? i.mode === 'native' : i.mode === 'filmstrip'));
    return { pass, evidence: rows.map(({ n, i }) => `${n}: ${i.container}/${i.codec} ${i.mode}${i.reason ? ` (${i.reason})` : ''} ${i.width}×${i.height}`).join('; ') };
  });

  await check('P2', 'snap lands on the keyframe at or before t; exact lands on the frame shown at t', async () => {
    const out: string[] = [];
    let ok = true;
    for (const n of NATIVE.filter((x) => x.startsWith('pv-'))) { // the pv- fixtures key every 30 frames
      const snap = (await svc.previewFrame(FX(n), 1.7, { size: { w: 320, h: 320 } }))!;
      const exact = (await svc.previewFrame(FX(n), 1.7, { exact: true, size: { w: 320, h: 320 } }))!;
      // Fixtures key every 30 frames at 30 fps: the snap is the 1.0 s keyframe, the exact frame 1.6667 s.
      const good = Math.abs(snap.time - 1) < 1e-3 && !snap.exact && exact.exact && exact.time <= 1.7 + 1e-6 && 1.7 - exact.time < 1 / 30 + 1e-6;
      ok &&= good;
      out.push(`${n} snap ${snap.time.toFixed(3)} exact ${exact.time.toFixed(4)}${good ? '' : ' ✗'}`);
    }
    return { pass: ok, evidence: out.join('; ') };
  });

  await check('P3', 'exact frames match an ffmpeg reference decode (B-frames, VP9, HEVC, AV1)', async () => {
    const out: string[] = [];
    let ok = true;
    for (const n of ['pv-h264.mkv', 'pv-vp9.webm', 'pv-hevc.mp4', 'pv-av1.mp4', 'src-a.mp4']) {
      for (const t of [0.4, 2.35]) {
        const f = (await svc.previewFrame(FX(n), t, { exact: true, size: { w: 320, h: 320 } }))!;
        const d = meanDiff(f.data, reference(FX(n), f.time, f.w, f.h));
        ok &&= d < 4;
        out.push(`${n}@${f.time.toFixed(3)} ${d.toFixed(2)}`);
      }
    }
    return { pass: ok, evidence: `mean |preview − ffmpeg| per channel (0–255; under 4 is the same frame, different scaler): ${out.join(', ')}` };
  });

  await check('P4', 'rotation: a 90° phone clip previews upright at its display size', async () => {
    const f = (await svc.previewFrame(FX('pv-rot90.mp4'), 1.2, { exact: true, size: { w: 400, h: 400 } }))!;
    const up = meanDiff(f.data, reference(FX('pv-rot90.mp4'), f.time, f.w, f.h)); // ffmpeg rotates by default
    return { pass: f.w === 180 && f.h === 320 && up < 4, evidence: `${f.w}×${f.h}, mean difference from ffmpeg's rotated decode ${up.toFixed(2)}` };
  });

  await check('P5', 'latest request wins: a hover burst decodes only what is still wanted', async () => {
    const file = FX('src-a.mp4');
    await svc.previewFrame(file, 0, { size: { w: 160, h: 90 } });
    const reqs = Array.from({ length: 24 }, (_, i) => svc.previewFrame(file, 0.2 + i * 0.4, { exact: true, size: { w: 160, h: 90 } }));
    const res = await Promise.all(reqs);
    const served = res.filter(Boolean).length;
    const last = res.at(-1);
    return { pass: !!last && Math.abs(last.time - (0.2 + 23 * 0.4)) < 1 / 30 + 1e-6 && served <= 3, evidence: `24 requests fired without waiting: ${served} decoded, ${24 - served} superseded (null); the last landed at ${last?.time.toFixed(3)} s` };
  });

  await check('P6', 'the frame cache serves a repeat without decoding', async () => {
    const file = FX('pv-av1.mp4');
    const t0 = performance.now(); const a = (await svc.previewFrame(file, 2.2, { exact: true, size: { w: 320, h: 180 } }))!; const cold = performance.now() - t0;
    const t1 = performance.now(); const b = (await svc.previewFrame(file, 2.2, { exact: true, size: { w: 320, h: 180 } }))!; const warm = performance.now() - t1;
    return { pass: b === a && warm < cold, evidence: `cold ${cold.toFixed(1)} ms, repeat ${warm.toFixed(2)} ms (same frame object)` };
  });

  await check('P7', 'preview beside export: the export is byte-identical with or without raw previews in between', async () => {
    const doc: ProjectDoc = newProject('p7', { working: { w: 640, h: 360 } });
    svc.updateProject(doc);
    const r = await svc.importClip(FX('src-b.mp4'), undefined, undefined, { proxyFirst: false });
    doc.resources.sources.push(r.source); doc.resources.conforms.push(r.conform);
    doc.timeline.blocks = [withChain(newBlock('picture', r.source.id, 0, 90), [{ kind: 'fx.feedback' }]), newBlock('motion', r.source.id, 120, 200)];
    svc.updateProject(doc);
    const cfg = { format: 'mp4-h264' as const, width: 640, height: 360, audio: true };
    const a = path.join(DIR, 'p7-a.mp4'), b = path.join(DIR, 'p7-b.mp4');
    await svc.render({ id: 'a', name: 'a', config: cfg, outPath: a }, () => {});
    // Hammer every native preview format, including the clip the export uses, then export again.
    for (const n of [...NATIVE, 'src-b.mp4']) for (const t of [0.3, 1.1, 2.6]) { await svc.previewFrame(FX(n), t, { size: { w: 320, h: 320 } }); await svc.previewFrame(FX(n), t, { exact: true, size: { w: 320, h: 320 } }); }
    const exp = svc.render({ id: 'b', name: 'b', config: cfg, outPath: b }, () => {});
    await Promise.all([exp, svc.previewFrame(FX('pv-hevc.mp4'), 1.5, { exact: true, size: { w: 320, h: 180 } })]); // and during it
    const same = fs.readFileSync(a).equals(fs.readFileSync(b));
    return { pass: same, evidence: `${fs.statSync(a).size} B export, ${same ? 'byte-identical' : 'DIFFERS'} after ${(NATIVE.length + 1) * 6} raw preview frames between and one during` };
  });

  await check('P8', 'filmstrip fallback through the service for the formats WebCodecs cannot decode', async () => {
    const rows = await Promise.all(FALLBACK.map(async (n) => ({ n, s: await svc.filmstrip(FX(n), { count: 8, width: 120 }) })));
    let refused = '';
    try { await svc.previewFrame(FX('pv-prores.mov'), 1, { size: { w: 160, h: 90 } }); } catch (e) { refused = (e as MoshpitError).code; }
    return { pass: rows.every((r) => r.s.cells.length === 8) && refused === 'PREVIEW_UNSUPPORTED', evidence: `${rows.map((r) => `${r.n}: 8 stills over ${r.s.durationSec.toFixed(2)} s`).join('; ')}; previewFrame on ProRes → ${refused}` };
  });

  // Timings on real camera/phone/download files where this machine has them (not a pass/fail case).
  const REAL = (process.env.PREVIEW_REAL ?? '').split(';').filter((f) => f && fs.existsSync(f));
  for (const f of REAL) {
    const info = await svc.previewInfo(f);
    if (info.mode !== 'native') { notes.push(`${path.basename(f)}: ${info.mode} (${info.reason})`); continue; }
    const snap: number[] = [], exact: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t = ((i * 7919) % 97) / 97 * info.durationSec;
      let t0 = performance.now(); await svc.previewFrame(f, t, { size: { w: 320, h: 320 } }); snap.push(performance.now() - t0);
      t0 = performance.now(); await svc.previewFrame(f, t, { exact: true, size: { w: 320, h: 320 } }); exact.push(performance.now() - t0);
    }
    svc.closePreview(f);
    notes.push(`${path.basename(f)} (${info.container}/${info.codec} ${info.width}×${info.height}): snap ${med(snap).toFixed(0)} ms median / ${Math.max(...snap).toFixed(0)} max, exact ${med(exact).toFixed(0)} / ${Math.max(...exact).toFixed(0)} ms`);
  }
  for (const n of notes) log(`[preview] ${n}`);
  svc.dispose();
  return { tests, notes };
}
