// A16: a 60-minute export at 1920×1080 on real footage, memory sampled throughout. The plan proved
// 20 minutes flat in the spike and asked for 60+ before promising multi-hour renders.
// Source: the spike's 20-minute ocean clip conformed through the v3 recipe, used three times:
// picture [0,36000) · motion [5,36000) (a seam mosh, stateful feedback) · picture [0,36000) with
// a plane desync. Exported through the real export path (software H.264, streamed), output deleted.
//
// Scratch uses a fresh run directory under LONG_DIR (or the harness output folder).
// The caller-supplied parent is never deleted. Disk-space checks cover scratch and cache.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcRenderer } from 'electron';
import { conform, probe, sourceHash, type ConformSettings } from '../../engine/src/conform/conform';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { compileProject, engineOptions } from '../../engine/src/runtime/session';
import { Engine } from '../../engine/src/runtime/engine';
import { exportRange } from '../../engine/src/runtime/export';
import type { ConformedSource, SourceId } from '@moshpit/core';
import { OUT, ROOT } from './fixtures';
import type { TestResult } from './gate';

const log = (m: string) => ipcRenderer.send('log', m);
const SRC = process.env.LONG_SOURCE ?? ''; // Optional benchmark input must be supplied explicitly.
const CACHE = path.join(ROOT, 'out', 'scale-cache');
const LONG_ROOT = path.resolve(process.env.LONG_DIR ?? path.join(OUT, 'long')); 
const GiB = 2 ** 30;
const free = (p: string) => { const s = fs.statfsSync(p); return s.bavail * s.bsize; };

export async function runLong(): Promise<{ tests: TestResult[]; notes: string[] }> {
  const notes: string[] = [];
  if (!SRC || !path.isAbsolute(SRC) || !fs.statSync(SRC).isFile()) throw new Error('Set LONG_SOURCE to an existing absolute video path');
  fs.mkdirSync(LONG_ROOT, { recursive: true });
  const DIR = fs.mkdtempSync(path.join(LONG_ROOT, 'run-')); // Only this newly created directory is disposable.
  if (free(DIR) < 40 * GiB) throw new Error(`long: ${(free(DIR) / GiB).toFixed(1)} GiB free at ${DIR}, need 40`);
  const p = await probe(SRC);
  const side = path.join(CACHE, `${path.basename(SRC)}.record.json`);
  let rec: ConformedSource;
  if (fs.existsSync(side) && fs.existsSync((rec = JSON.parse(fs.readFileSync(side, 'utf8'))).path)) notes.push('conform: cached');
  else {
    const t = performance.now();
    const s: ConformSettings = { fps: p.fps, width: 1920, height: 1080, proxyDivisor: 4, crf: 18 };
    let last = -1;
    rec = (await conform('long-src' as SourceId, SRC, s, CACHE, (f) => { const pc = Math.floor(f * 20) * 5; if (pc !== last) { last = pc; log(`[long] conform ${pc}%`); } })).record;
    fs.writeFileSync(side, JSON.stringify(rec, null, 2));
    notes.push(`conform: ${rec.frames} frames in ${((performance.now() - t) / 60000).toFixed(1)} min`);
  }
  const doc = newProject('long', { working: { w: 1920, h: 1080 }, fps: rec.fps });
  doc.resources.sources.push({ id: rec.sourceId, name: path.basename(SRC), path: SRC, sourceHash: sourceHash(SRC), probe: p, chapters: [], marks: [], conformId: rec.id, motionSignature: null });
  doc.resources.conforms.push(rec);
  const n = rec.frames, S = rec.sourceId;
  doc.timeline.blocks = [
    withChain(newBlock('picture', S, 0, n), [{ kind: 'fx.feedback', params: { decay: 0.7 } }]),
    withChain(newBlock('motion', S, 5, n), [{ kind: 'fx.feedback-trail', params: { amount: 40, back: 3 } }]),
    withChain(newBlock('picture', S, 0, n), [{ kind: 'fx.plane-desync', params: { dx: 20 } }]),
  ];
  const c = compileProject(doc);
  const N = c.plan.frames;
  notes.push(`timeline: ${N} frames = ${(N * rec.fps.den / rec.fps.num / 60).toFixed(1)} min at 1920×1080`);
  const samples: { t: number; frame: number; vram: number | null; ram: number; spill: number }[] = [];
  const sampleFile = path.join(OUT, 'long-samples.jsonl');
  fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(sampleFile, '');
  let frame = 0, pct = -1;
  const t0 = performance.now(), ac = new AbortController();
  const e = new Engine(engineOptions(doc, c, { cacheDir: path.join(DIR, 'engine'), role: 'export', decodeAccel: 'prefer-software', spillBytes: 4 * GiB }));
  const sampler = setInterval(async () => {
    const m = await ipcRenderer.invoke('metrics');
    const x = { t: (performance.now() - t0) / 1000, frame, vram: m.vram, ram: m.ram, spill: e.stats.spills };
    samples.push(x); fs.appendFileSync(sampleFile, JSON.stringify(x) + '\n');
    for (const d of [DIR, CACHE]) if (free(d) < 10 * GiB) { log(`[long] ABORT: ${d} below 10 GiB free`); ac.abort(); }
  }, 5000);
  const file = path.join(DIR, 'long-60min.mp4');
  let rep, size = 0;
  try {
    rep = await exportRange(e, doc, c.plan, { format: 'mp4-h264', width: 1920, height: 1080, audio: true }, file, {
      tmpDir: path.join(DIR, 'tmp'), bitrate: 8e6, signal: ac.signal,
      onProgress: (f, t) => { frame = t; const p = Math.floor(f * 20) * 5; if (p !== pct) { pct = p; log(`[long] ${p}% (${t}/${N})`); } },
    });
    size = fs.statSync(file).size;
  } finally { clearInterval(sampler); e.dispose(); c.close(); fs.rmSync(DIR, { recursive: true, force: true }); }
  const q = (k: 'vram' | 'ram') => [0, 1, 2, 3].map((i) => { const s = samples.filter((x) => x.frame >= (i * N) / 4 && x.frame < ((i + 1) * N) / 4).map((x) => x[k] ?? 0); return s.length ? Math.max(...s) : 0; });
  const vq = q('vram'), rq = q('ram').map((b) => b / 2 ** 30);
  const flat = Math.max(...vq) - Math.min(...vq.filter(Boolean)) < 256 && Math.max(...rq) - Math.min(...rq.filter(Boolean)) < 0.5;
  const tests: TestResult[] = [{
    id: 'L1', name: '60-minute 1080p export: completes, memory flat by quarter', pass: rep.frames === N && flat,
    evidence: `${rep.frames}/${N} frames in ${(rep.ms / 60000).toFixed(1)} min (${rep.fps.toFixed(1)} fps), ${(size / 2 ** 30).toFixed(2)} GiB MP4 with audio; peak VRAM per quarter ${vq.join(' / ')} MiB; peak RAM (all app processes) per quarter ${rq.map((x) => x.toFixed(2)).join(' / ')} GiB; ${samples.length} samples; ${e.stats.spills} spills, ${e.stats.spillDrops} dropped at the 4 GiB cap`,
  }];
  return { tests, notes };
}
