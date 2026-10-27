// Production scale at the canonical 1920×1080 on real footage: the spike's GoPro clip (2 min,
// 3,596 frames at 30000/1001) conformed through the v3 recipe, then a four-block timeline with
// stateful effects across a merged mosh segment. Measures what the toy-size gate cannot:
// throughput, VRAM, determinism, seek correctness, freeze, and the F2 scrub cost on the master
// against the keyframe-locked proxy (design call 2). The source is read, never written (rule 5).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcRenderer } from 'electron';
import { conform, probe, sourceHash, type ConformSettings } from '../../engine/src/conform/conform';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { compileProject, engineOptions } from '../../engine/src/runtime/session';
import { Engine } from '../../engine/src/runtime/engine';
import { MoshpitError } from '../../engine/src/errors';
import type { ConformedSource, ProjectDoc, SourceClip, SourceId } from '../../engine/src/model';
import { OUT, ROOT } from './fixtures';
import type { TestResult } from './gate';

const log = (m: string) => ipcRenderer.send('log', m);
const SRC = process.env.SCALE_SOURCE ?? path.join(ROOT, '..', 'moshpit-v3-spike', 'fixtures-real', 'gopro-uw-1080p.mp4');
const CACHE = path.join(ROOT, 'out', 'scale-cache');

async function conformOnce(file: string, s: ConformSettings): Promise<{ rec: ConformedSource; ms: number }> {
  const side = path.join(CACHE, `${path.basename(file)}.record.json`);
  if (fs.existsSync(side)) { const rec = JSON.parse(fs.readFileSync(side, 'utf8')) as ConformedSource; if (fs.existsSync(rec.path)) return { rec, ms: -1 }; }
  const t = performance.now();
  const r = await conform('scale-src' as SourceId, file, s, CACHE, (f) => { if (Math.round(f * 100) % 10 === 0) log(`[scale] conform ${(f * 100).toFixed(0)}%`); });
  fs.writeFileSync(side, JSON.stringify(r.record, null, 2));
  return { rec: r.record, ms: performance.now() - t };
}

export async function runScale(): Promise<{ tests: TestResult[]; notes: string[]; env: unknown }> {
  const tests: TestResult[] = [], notes: string[] = [];
  const vram: number[] = [];
  const sampler = setInterval(async () => { const v = await ipcRenderer.invoke('vram'); if (v) vram.push(v); }, 1000);
  const baseline = await ipcRenderer.invoke('vram');
  const check = async (id: string, name: string, fn: () => Promise<{ pass: boolean; evidence: string }>) => {
    const t0 = performance.now();
    try { tests.push({ id, name, ...(await fn()), ms: Math.round(performance.now() - t0) }); }
    catch (e) { tests.push({ id, name, pass: false, evidence: `threw: ${e instanceof MoshpitError ? JSON.stringify(e.toJSON()) : (e as Error)?.stack ?? e}` }); }
    const r = tests[tests.length - 1];
    log(`[scale] ${r.pass ? 'PASS' : 'FAIL'} ${id} (${r.ms} ms) ${r.evidence.slice(0, 220)}`);
  };

  const p = await probe(SRC);
  const settings: ConformSettings = { fps: p.fps, width: 1920, height: 1080, proxyDivisor: 4, crf: 15 };
  const { rec, ms: conformMs } = await conformOnce(SRC, settings);
  notes.push(`source ${path.basename(SRC)}: ${p.codec} ${p.width}x${p.height} ${p.fps.num}/${p.fps.den}; conform ${conformMs < 0 ? 'cached' : `${(conformMs / 1000).toFixed(0)} s (${(rec.frames / (conformMs / 1000)).toFixed(1)} fps incl. proxy)`} → ${rec.frames} frames, ${rec.keyframes.length} IDRs, moshable ${rec.moshable}`);

  const doc: ProjectDoc = newProject('scale 1080p', { working: { w: 1920, h: 1080 }, fps: rec.fps });
  const src: SourceClip = { id: rec.sourceId, name: path.basename(SRC), path: SRC, sourceHash: sourceHash(SRC), probe: p, chapters: [], marks: [], conformId: rec.id, motionSignature: null };
  doc.resources.sources.push(src); doc.resources.conforms.push(rec);
  // p1 picture [0,600) · m1 motion [1210,1810) · m2 motion [2410,3010) · p2 picture [3050,3590)
  doc.timeline.blocks = [
    withChain(newBlock('picture', src.id, 0, 600), [{ kind: 'fx.plane-desync', params: { dx: 24, noise: 0.3 } }, { kind: 'fx.feedback', params: { decay: 0.8 } }]),
    withChain(newBlock('motion', src.id, 1210, 1810), [{ kind: 'fx.feedback', params: { decay: 0.85, zoom: 0.99 } }]),
    withChain(newBlock('motion', src.id, 2410, 3010), [{ kind: 'fx.plane-desync', params: { channel: 'b', dx: -30 } }]),
    newBlock('picture', src.id, 3050, 3590),
  ];
  const cm = compileProject(doc);
  const N = cm.plan.frames;
  const mk = (role: 'export' | 'preview', variant: 'master' | 'proxy' = 'master', accel: HardwareAcceleration = 'prefer-software') => {
    const c = variant === 'master' ? cm : compileProject(doc, { variant });
    return new Engine(engineOptions(doc, c, { cacheDir: path.join(OUT, 'scale-engine'), role, decodeAccel: accel }));
  };
  notes.push(`timeline ${N} frames at 1920×1080, mosh ranges ${JSON.stringify(cm.plan.moshRanges)}, ${Array.from(cm.plan.held).reduce((a, b) => a + b, 0)} held slots`);

  let GT!: Float64Array;
  await check('P1', 'Linear render at 1920×1080: throughput and VRAM', async () => {
    const e = mk('export');
    const t = performance.now();
    await e.renderRange(0, N - 1, { hash: true });
    const fps = N / ((performance.now() - t) / 1000);
    GT = e.hashes.slice();
    const g = e.gpu;
    e.dispose();
    return { pass: fps > 10, evidence: `${N} frames at ${fps.toFixed(1)} fps (software decode, readback + hash every frame); engine texture accounting peak ${(g.peakBytes / 2 ** 20).toFixed(0)} MiB; ${g.checkpoints} checkpoints held` };
  });

  await check('P2', 'Byte-identical across engines (L11 at scale)', async () => {
    const h = async () => { const e = mk('export'); const s = crypto.createHash('sha256'); await e.renderRange(560, 760, { onFrame: (px) => s.update(px) }); e.dispose(); return s.digest('hex'); };
    const a = await h(), b = await h();
    return { pass: a === b, evidence: `frames 560–760 (crosses the p1→m1 seam): ${a === b ? 'equal' : 'DIFFER'} sha256 on two fresh engines (${(201 * 1920 * 1080 * 4 / 1e9).toFixed(2)} GB each)` };
  });

  await check('P3', 'Cold seeks into stateful moshed blocks equal linear', async () => {
    const e = mk('export');
    const frames = [1150, 700, 1799, 640, 1500, 2300];
    const t = performance.now();
    for (const f of frames) await e.renderRange(f, f, { hash: true });
    const per = (performance.now() - t) / frames.length;
    const bad = frames.filter((f) => e.hashes[f] !== GT[f]);
    const st = e.stats; e.dispose();
    return { pass: bad.length === 0, evidence: `${frames.length} cold seeks, ${bad.length} mismatches; ${(per / 1000).toFixed(2)} s per seek on average (${st.decoded} decodes, ${st.replayed} replayed); checkpoint spills ${st.spills}, unspills ${st.unspills}` };
  });

  await check('P4', 'Freeze 120 frames of a stateful moshed block; read back', async () => {
    const e = mk('preview');
    const blk = cm.plan.blocks[1];
    const t = performance.now();
    await e.freeze(blk.blockId, blk.start + 300, blk.start + 419);
    const bounce = performance.now() - t;
    const s0 = e.stats.decoded;
    const t2 = performance.now();
    await e.renderRange(blk.start + 300, blk.start + 419, { hash: true });
    const read = performance.now() - t2;
    let eq = true;
    for (let f = blk.start + 300; f <= blk.start + 419; f++) if (e.hashes[f] !== GT[f]) eq = false;
    const decoded = e.stats.decoded - s0;
    e.dispose();
    return { pass: eq && decoded === 0, evidence: `bounce ${(bounce / 1000).toFixed(1)} s (${(120 * 1920 * 1080 * 4 / 1e9).toFixed(2)} GB raw); read back at ${(120 / (read / 1000)).toFixed(0)} fps with ${decoded} decodes, equal to live: ${eq}` };
  });

  await check('P5', 'F2: backward scrub inside the merged segment, master vs keyframe-locked proxy', async () => {
    const blk = cm.plan.blocks[1];
    const steps = 20, from = blk.start + 400;
    const scrub = async (e: Engine) => { const t = performance.now(); for (let f = from; f > from - steps; f--) await e.renderRange(f, f, { hash: true }); const ms = (performance.now() - t) / steps; const d = e.stats.decoded; e.dispose(); return { ms, d }; };
    const m = await scrub(mk('export', 'master', 'prefer-software'));
    const mh = await scrub(mk('preview', 'master', 'no-preference'));
    const px = await scrub(mk('preview', 'proxy', 'no-preference'));
    return { pass: px.ms < m.ms, evidence: `${steps} backward single-frame steps at frame ~${from}: master software ${m.ms.toFixed(0)} ms/step, master hardware-or-software ${mh.ms.toFixed(0)} ms/step, proxy (480×270) ${px.ms.toFixed(0)} ms/step — ${(m.ms / px.ms).toFixed(1)}× faster than the master, same mosh structure` };
  });

  clearInterval(sampler);
  const peak = vram.length ? Math.max(...vram) : null;
  notes.push(`VRAM (nvidia-smi, whole board): baseline ${baseline} MiB, peak ${peak} MiB over the run (+${peak && baseline ? peak - baseline : '?'} MiB)`);
  fs.rmSync(path.join(OUT, 'scale-engine'), { recursive: true, force: true });
  cm.close();
  return { tests, notes, env: { source: SRC, frames: N, gpu: 'see tests' } };
}
