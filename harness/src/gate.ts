// The M0 gate, carried forward as M1 regression tests: the spike's 9 cases (tests.js), its
// negative control and its allocation probe, re-targeted at the two-stage engine and a five-block,
// three-clip timeline. Tolerance 0 everywhere a case claims identity. T8 carries the F1
// tightening (a boundary at every removed keyframe), T9 the B2 freeze-key checks.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcRenderer } from 'electron';
import { Engine, type EngineOptions } from '../../engine/src/runtime/engine';
import { compileProject, engineOptions } from '../../engine/src/runtime/session';
import { H264Encoder } from '../../engine/src/runtime/encode';
import { duplicateBlock } from '../../engine/src/project/build';
import type { BlockId, ProjectDoc } from '../../engine/src/model';
import { MoshpitError } from '../../engine/src/errors';
import { OUT, gateProject } from './fixtures';

export interface TestResult { id: string; name: string; pass: boolean; evidence: string; detail?: unknown; ms?: number }
const log = (m: string) => ipcRenderer.send('log', m);
const CACHE = path.join(OUT, 'engine-cache');

const live: Engine[] = [];
const toClose: (() => void)[] = [];
function mk(doc: ProjectDoc, o: { role?: 'export' | 'preview'; gpuProxy?: boolean; decodeAccel?: HardwareAcceleration; budgetBytes?: number; checkpointTextures?: number } = {}): Engine {
  const c = compileProject(doc, { gpuProxy: o.gpuProxy, backend: o.role === 'preview' ? 'preview' : 'export' });
  toClose.push(c.close);
  const e = new Engine(engineOptions(doc, c, { cacheDir: CACHE, role: o.role ?? 'export', decodeAccel: o.decodeAccel ?? 'prefer-software', budgetBytes: o.budgetBytes, checkpointTextures: o.checkpointTextures }));
  live.push(e);
  return e;
}
function free() { while (live.length) live.pop()!.dispose(); while (toClose.length) toClose.pop()!(); }
function recompile(doc: ProjectDoc, gpuProxy = false): Pick<EngineOptions, 'plan' | 'moshed' | 'blocks' | 'blockPlans' | 'lfos'> {
  const c = compileProject(doc, { gpuProxy });
  toClose.push(c.close);
  return { plan: c.plan, moshed: c.moshed, blocks: doc.timeline.blocks, blockPlans: c.blockPlans, lfos: doc.modulators.lfos };
}
const delta = (e: Engine, s0: Engine['stats']) => Object.fromEntries(Object.entries(e.stats).map(([k, v]) => [k, v - (s0 as Record<string, number>)[k]])) as Engine['stats'];
const snap = (e: Engine) => ({ ...e.stats });
const mismatches = (h: Float64Array, gt: Float64Array, a: number, b: number) => { const m: number[] = []; for (let i = a; i <= b; i++) if (h[i] !== gt[i]) m.push(i); return m; };
async function linear(doc: ProjectDoc, a = 0, b?: number): Promise<Float64Array> {
  const e = mk(doc);
  await e.renderRange(a, b ?? e.hashes.length - 1, { hash: true });
  const h = e.hashes.slice();
  live.splice(live.indexOf(e), 1); e.dispose();
  return h;
}
async function sha(e: Engine, a: number, b: number, file: string | null = null): Promise<string> {
  const h = crypto.createHash('sha256'), fd = file ? fs.openSync(file, 'w') : null;
  try { await e.renderRange(a, b, { onFrame: (px) => { h.update(px); if (fd !== null) fs.writeSync(fd, px); } }); } finally { if (fd !== null) fs.closeSync(fd); }
  return h.digest('hex');
}
function mad(x: Uint8Array, y: Uint8Array): number {
  let s = 0, n = 0;
  for (let i = 0; i < x.length; i += 16, n++) s += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
  return s / (n * 3);
}

// Gate timeline layout (fixtures.ts): p1 [0,150) m1 [150,300) m2 [300,420) p2 [420,510) m3 [510,605) [605,700).
const M2: [number, number] = [300, 419];

export async function runGate(): Promise<{ tests: TestResult[]; notes: string[]; env: unknown }> {
  fs.rmSync(CACHE, { recursive: true, force: true });
  const doc = await gateProject();
  const tests: TestResult[] = [];
  const notes: string[] = [];
  const probe = mk(doc);
  const N = probe.hashes.length;
  const env = { chrome: process.versions.chrome, electron: process.versions.electron, gpu: probe.gpu.gpuName, frames: N, size: `${probe.w}x${probe.h}`, moshRanges: (probe as unknown as { plan: { moshRanges: unknown } }).plan.moshRanges, fingerprint: probe.fingerprint };
  free();
  log(`[gate] ${env.size}, ${N} frames, ranges ${JSON.stringify(env.moshRanges)}, ${env.gpu}`);
  let t0 = performance.now();
  const GT = await linear(doc);
  notes.push(`reference linear pass: ${(N / ((performance.now() - t0) / 1000)).toFixed(0)} fps`);
  free();

  const TESTS: [string, string, () => Promise<Omit<TestResult, 'id' | 'name'>>][] = [
    ['T1', 'Seek cold (inside a merged mosh segment, stateful block) and far', async () => {
      const e = mk(doc);
      await e.renderRange(400, 400, { hash: true });
      const cold = snap(e);
      await e.renderRange(400, 400, { hash: true });
      const s0 = snap(e);
      await e.renderRange(690, 690, { hash: true });
      const far = delta(e, s0);
      const pass = e.hashes[400] === GT[400] && e.hashes[690] === GT[690];
      return { pass, evidence: `cold seek to 400 replayed ${cold.replayed} frames from the block start (${cold.decoded} decodes: the merged segment runs back to frame 0); far seek to 690 replayed ${far.replayed} (${far.decoded} decodes); both hash-equal linear playback: ${pass}`, detail: { cold, far } };
    }],
    ['T2', `Scrub backward ${M2[1]}→${M2[0]}`, async () => {
      const e = mk(doc);
      await e.renderRange(M2[0], M2[1], { hash: true });
      e.hashes.fill(0);
      const s0 = snap(e), t = performance.now();
      for (let f = M2[1]; f >= M2[0]; f--) await e.renderRange(f, f, { hash: true });
      const d = delta(e, s0), ms = (performance.now() - t) / (M2[1] - M2[0] + 1);
      const bad = mismatches(e.hashes, GT, M2[0], M2[1]);
      return { pass: bad.length === 0, evidence: `${M2[1] - M2[0] + 1} backward single-frame seeks, ${bad.length} mismatches; ${d.decoded} decodes, ${d.replayed} replayed (checkpoints every 30 frames); ${ms.toFixed(0)} ms per step at this size`, detail: { bad: bad.slice(0, 20), d } };
    }],
    ['T3', `Loop ${M2[0]}–${M2[1]} ×3`, async () => {
      const e = mk(doc);
      const iters: Float64Array[] = [], reps: number[] = [];
      for (let k = 0; k < 3; k++) { const s0 = snap(e); await e.renderRange(M2[0], M2[1], { hash: true }); reps.push(e.stats.replayed - s0.replayed); iters.push(e.hashes.slice(M2[0], M2[1] + 1)); }
      const same = iters.every((it) => it.every((h, j) => h === iters[0][j]));
      const bad = mismatches(e.hashes, GT, M2[0], M2[1]);
      return { pass: same && bad.length === 0, evidence: `3 iterations ${same ? 'identical' : 'DIFFER'}, ${bad.length} mismatches vs linear; replayed per entry ${JSON.stringify(reps)} (the loop start is the block start: state resets there, S1)` };
    }],
    ['T4', 'Change an upstream slice: only affected frames recompute', async () => {
      const runCase = async (fx: boolean) => {
        const base = fx ? doc : await gateProject({ effects: false });
        const edited: ProjectDoc = structuredClone(base);
        edited.timeline.blocks[1] = { ...edited.timeline.blocks[1], in: 25, out: 175 }; // m1 slides 5 frames, same length
        const truth = await linear(edited, 140, 450);
        const e = mk(base);
        await e.renderRange(0, N - 1, { hash: true });
        const dirty = e.update(recompile(edited));
        const s0 = snap(e);
        await e.renderRange(140, 450, { hash: true, useCache: true });
        const d = delta(e, s0);
        let inside = 0;
        for (let i = 140; i <= 450; i++) if (dirty.some(([s, x]) => i >= s && i < x)) inside++;
        return { dirty, d, inside, bad: mismatches(e.hashes, truth, 140, 450) };
      };
      const on = await runCase(true);
      free();
      const off = await runCase(false);
      const ok = (c: Awaited<ReturnType<typeof runCase>>) => c.bad.length === 0 && c.dirty[0][0] === 150 && c.dirty.every(([, x]) => x <= 420) && c.d.cacheHits === 311 - c.inside;
      return { pass: ok(on) && ok(off), evidence: `m1 slid [20,170)→[25,175). Effects on: dirty ${JSON.stringify(on.dirty)}, 140–450 = ${on.d.cacheHits} cache hits + ${on.inside} recomputed, ${on.bad.length} mismatches vs a fresh render. Effects off: dirty ${JSON.stringify(off.dirty)}, ${off.d.cacheHits} hits, ${off.bad.length} mismatches. Nothing before the edited block or after the next picture block's primer is touched`, detail: { on, off } };
    }],
    ['T5', `Export ${M2[0]}–${M2[1]} twice; preview vs export parity`, async () => {
      const runs = [];
      for (let r = 1; r <= 2; r++) {
        const e = mk(doc);
        const file = path.join(OUT, `gate-export-${r}.h264`);
        fs.rmSync(file, { force: true });
        const enc = await H264Encoder.open(file, e.w, e.h, { num: 30, den: 1 });
        const h = crypto.createHash('sha256');
        let i = 0;
        await e.renderRange(M2[0], M2[1], { hash: true, onFrame: (px) => { h.update(px); enc.encode(px, e.w, e.h, i++); }, gate: () => enc.ready() });
        await enc.close();
        runs.push({ rgba: h.digest('hex'), h264: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: enc.bytes, codec: enc.codec, matchesGT: mismatches(e.hashes, GT, M2[0], M2[1]).length === 0 });
      }
      // Parity (L18): an all-EXACT graph in the preview role equals export, byte for byte, on the same decoder.
      const cap = async (role: 'export' | 'preview', accel: HardwareAcceleration, tag: string) => { const e = mk(doc, { role, decodeAccel: accel }); const f = path.join(OUT, `gate-parity-${tag}.rgba`); await sha(e, M2[0], M2[1], f); return f; };
      const ex = await cap('export', 'prefer-software', 'export'), pv = await cap('preview', 'prefer-software', 'preview'), hw = await cap('preview', 'prefer-hardware', 'hw');
      const diff = (p: string, q: string) => { const A = fs.readFileSync(p), B = fs.readFileSync(q); let max = 0, sum = 0, off = 0; for (let i = 0; i < A.length; i++) { const d = Math.abs(A[i] - B[i]); sum += d; if (d) off++; if (d > max) max = d; } return { max, mean: sum / A.length, offFrac: off / A.length }; };
      const parity = diff(pv, ex), hwDev = diff(hw, ex);
      for (const f of [pv, ex, hw]) fs.rmSync(f);
      const pass = runs[0].rgba === runs[1].rgba && runs[0].h264 === runs[1].h264 && runs[0].matchesGT && parity.max === 0;
      return { pass, evidence: `two exports: RGBA sha256 ${runs[0].rgba === runs[1].rgba ? 'equal' : 'DIFFER'}, H.264 ${runs[0].codec} software (${runs[0].bytes} B) sha256 ${runs[0].h264 === runs[1].h264 ? 'equal' : 'DIFFER'}; export equals linear: ${runs[0].matchesGT}; EXACT preview vs export max pixel diff ${parity.max}/255. Measured, not asserted (L30: hardware is preview-only): hardware-decode preview vs export mean ${hwDev.mean.toFixed(3)}/255, max ${hwDev.max}/255, ${(100 * hwDev.offFrac).toFixed(2)}% of bytes differ`, detail: { runs, parity, hwDev } };
    }],
    ['T6', 'Duplicate the component: independent instance, identity and seed', async () => {
      const p1 = doc.timeline.blocks[0];
      const dup = duplicateBlock(p1);
      const both: ProjectDoc = { ...structuredClone(doc), timeline: { blocks: [structuredClone(p1), dup] } };
      const solo: ProjectDoc = { ...structuredClone(doc), timeline: { blocks: [structuredClone(p1)] } };
      const hSolo = await linear(solo);
      const e = mk(both);
      await e.renderRange(0, 299, { hash: true });
      const aIntact = mismatches(e.hashes, hSolo, 0, 149).length === 0;
      let differ = 0;
      for (let i = 0; i < 150; i++) if (e.hashes[i] !== e.hashes[150 + i]) differ++;
      const before = e.hashes.slice(150, 300);
      const edited = structuredClone(both);
      const pd = edited.timeline.blocks[0].graph.nodes.find((n) => n.kind === 'fx.plane-desync')!;
      pd.params.dx = -80;
      const dirty = e.update(recompile(edited));
      await e.renderRange(0, 299, { hash: true });
      const bAfter = e.hashes.slice(150, 300).every((h, j) => h === before[j]);
      const idsDistinct = new Set([...p1.graph.nodes, ...dup.graph.nodes].map((n) => n.id)).size === p1.graph.nodes.length * 2;
      const pass = aIntact && differ > 140 && bAfter && idsDistinct && dirty.length === 1 && dirty[0][0] === 0 && dirty[0][1] === 150;
      return { pass, evidence: `A unchanged by B's presence: ${aIntact}; A≠B on ${differ}/150 frames (node identity seeds the grain, timeline position the LFO); editing A dirtied ${JSON.stringify(dirty)} and left B intact: ${bAfter}; node identities distinct: ${idsDistinct}` };
    }],
    ['T7', 'Render the same range twice, byte-identical', async () => {
      const e = mk(doc);
      const h1 = await sha(e, M2[0], 520), h2 = await sha(e, M2[0], 520);
      const h3 = await sha(mk(doc), M2[0], 520);
      const full = await linear(doc);
      const fullBad = mismatches(full, GT, 0, N - 1).length;
      const pass = h1 === h2 && h2 === h3 && fullBad === 0;
      return { pass, evidence: `same engine twice + a fresh engine over ${M2[0]}–520 (crosses a picture block and an encoded reorder): sha256 ${h1 === h2 && h2 === h3 ? 'all equal' : 'DIFFER'} (${h1.slice(0, 16)}…); a full 0–${N - 1} render on a fresh engine: ${fullBad} of ${N} frames differ` };
    }],
    ['T8', 'Preview the mosh by GPU PROXY: mapping, boundaries, a hold at every removed keyframe (F1)', async () => {
      const off = await gateProject({ effects: false });
      const capture = async (e: Engine, name: string) => { const f = path.join(OUT, `gate-t8-${name}.rgba`); await sha(e, 0, N - 1, f); return f; };
      const cleanDoc = structuredClone(off);
      for (const b of cleanDoc.timeline.blocks) b.kind = 'picture';
      const C = await capture(mk(cleanDoc), 'clean');
      const exact = mk(off);
      const X = await capture(exact, 'exact');
      const proxy = mk(off, { role: 'preview', gpuProxy: true });
      const P = await capture(proxy, 'proxy');
      const FB = exact.w * exact.h * 4;
      const fC = fs.openSync(C, 'r'), fX = fs.openSync(X, 'r'), fP = fs.openSync(P, 'r');
      const c = Buffer.alloc(FB), x = Buffer.alloc(FB), p = Buffer.alloc(FB), xPrev = Buffer.alloc(FB), pPrev = Buffer.alloc(FB);
      const ranges = (exact as unknown as { plan: { moshRanges: [number, number][]; held: Uint8Array } }).plan;
      const proxyRanges = (proxy as unknown as { moshed: { moshRanges: [number, number][]; proxyHold: Uint8Array } }).moshed;
      const inR = (t: number) => ranges.moshRanges.some(([s, e]) => t >= s && t < e);
      let outsideOk = true, inN = 0, xCov = 0, pCov = 0, xp = 0;
      const holdChecks: { t: number; exactHeld: boolean | null; proxyHeld: boolean }[] = [];
      for (let t = 0; t < N; t++) {
        fs.readSync(fC, c, 0, FB, t * FB); fs.readSync(fX, x, 0, FB, t * FB); fs.readSync(fP, p, 0, FB, t * FB);
        if (!inR(t)) { if (!x.equals(c) || !p.equals(c)) outsideOk = false; }
        else { inN++; if (mad(x, c) > 1) xCov++; if (mad(p, c) > 1) pCov++; xp += mad(x, p); }
        if (proxyRanges.proxyHold[t] && t > 0) holdChecks.push({ t, exactHeld: ranges.held[t] ? x.equals(xPrev) : null, proxyHeld: p.equals(pPrev) });
        x.copy(xPrev); p.copy(pPrev);
      }
      fs.closeSync(fC); fs.closeSync(fX); fs.closeSync(fP);
      for (const f of [C, X, P]) fs.rmSync(f);
      const mapping = JSON.stringify(ranges.moshRanges) === JSON.stringify(proxyRanges.moshRanges);
      const removedKeyframes = holdChecks.filter((h) => h.exactHeld !== null);
      const holdsOk = holdChecks.every((h) => h.proxyHeld && h.exactHeld !== false) && removedKeyframes.length >= 2;
      const pass = mapping && outsideOk && xCov / inN >= 0.9 && pCov / inN >= 0.9 && holdsOk;
      return { pass, evidence: `shared mapping ${JSON.stringify(ranges.moshRanges)}: ${mapping}; outside it EXACT and PROXY byte-identical to clean: ${outsideOk}; inside, frames >1/255 off clean: EXACT ${(100 * xCov / inN).toFixed(0)}%, PROXY ${(100 * pCov / inN).toFixed(0)}%; hold points ${holdChecks.map((h) => h.t).join(',')}: PROXY holds at all ${holdChecks.length}, EXACT holds at both removed keyframes (${removedKeyframes.map((h) => h.t).join(',')}): ${holdsOk}. Declared divergence: EXACT vs PROXY mean ${(xp / inN).toFixed(1)}/255 (not asserted)`, detail: { holdChecks } };
    }],
    ['T9', 'Freeze, re-run, edit upstream (incl. an upstream block, B2)', async () => {
      const e = mk(doc, { role: 'preview' });
      await e.renderRange(M2[0], M2[1], { hash: true });
      const liveH = e.hashes.slice(M2[0], M2[1] + 1);
      const m2 = doc.timeline.blocks[2].id;
      const f1 = await e.freeze(m2, M2[0], M2[1]);
      let s0 = snap(e);
      await e.renderRange(M2[0], M2[1], { hash: true });
      const fr = delta(e, s0);
      const frozenEqLive = e.hashes.slice(M2[0], M2[1] + 1).every((h, j) => h === liveH[j]);
      const e2 = mk(doc);
      const f2 = await e2.freeze(m2, M2[0], M2[1]);
      const forced = await e2.freeze(m2, M2[0], M2[1], { force: true });
      const forcedIdentical = fs.readFileSync(forced.file).equals(fs.readFileSync(f1.file));
      fs.rmSync(forced.file);
      const variant = (fn: (d: ProjectDoc) => void) => { const d = structuredClone(doc); fn(d); return d; };
      const downstream = variant((d) => { d.timeline.blocks[3].graph.nodes.find((n) => n.kind === 'fx.plane-desync')!.params.dy = 60; });
      e.update(recompile(downstream));
      const staleDownstream = e.isStale(m2);
      const upFx = variant((d) => { d.timeline.blocks[1].graph.nodes.find((n) => n.kind === 'fx.plane-desync')!.params.dx = 99; });
      e.update(recompile(upFx));
      const staleUpstreamFx = e.isStale(m2);
      const upSlice = variant((d) => { d.timeline.blocks[1] = { ...d.timeline.blocks[1], in: 25, out: 175 }; });
      e.update(recompile(upSlice));
      const staleUpstreamSlice = e.isStale(m2);
      e.update(recompile(doc));
      const own = variant((d) => { d.timeline.blocks[2].graph.nodes.find((n) => n.kind === 'fx.feedback')!.params.decay = 0.5; });
      e.update(recompile(own));
      const staleOwn = e.isStale(m2);
      s0 = snap(e);
      await e.renderRange(M2[0], M2[1], { hash: true });
      const stalePlays = e.stats.decoded === s0.decoded && e.hashes.slice(M2[0], M2[1] + 1).every((h, j) => h === liveH[j]);
      // B2: an export-role engine holding the same, now stale, freeze re-renders instead of serving it.
      const ex = mk(doc);
      await ex.freeze(m2, M2[0], M2[1]);
      ex.update(recompile(own));
      s0 = snap(ex);
      await ex.renderRange(M2[0], M2[1], { hash: true });
      const exportRerenders = ex.stats.decoded > s0.decoded && ex.stats.frozenFrames === s0.frozenFrames;
      await e.freeze(m2, M2[0], M2[1]);
      await e.renderRange(M2[0], M2[1], { hash: true });
      const truth = await linear(own, M2[0], M2[1]);
      const refrozen = mismatches(e.hashes, truth, M2[0], M2[1]).length === 0 && !e.isStale(m2) && mismatches(ex.hashes, truth, M2[0], M2[1]).length === 0;
      const pass = !f1.hit && fr.decoded === 0 && fr.stepPasses === 0 && fr.frozenFrames === 120 && frozenEqLive && f2.hit && forcedIdentical
        && !staleDownstream && !staleUpstreamFx && staleUpstreamSlice && staleOwn && stalePlays && exportRerenders && refrozen;
      return { pass, evidence: `froze m2 ${M2[0]}–${M2[1]}; re-render read it (0 decodes, 0 GPU steps, ${fr.frozenFrames} frozen frames) and equals live: ${frozenEqLive}; a fresh engine hit the cache: ${f2.hit}; forced re-render byte-identical: ${forcedIdentical}. Stale after: a later block's edit ${staleDownstream}, an upstream block's effect edit ${staleUpstreamFx} (effects run after the mosh), an upstream block's slice edit ${staleUpstreamSlice} (B2), its own edit ${staleOwn}; a stale freeze still plays old bytes in preview: ${stalePlays}, and export re-renders it instead: ${exportRerenders}; re-freeze equals a fresh live render: ${refrozen}` };
    }],
  ];

  const only = (process.env.GATE_ONLY || '').split(',').filter(Boolean);
  for (const [id, name, fn] of TESTS) {
    if (only.length && !only.includes(id)) continue;
    t0 = performance.now();
    try { tests.push({ id, name, ...(await fn()), ms: Math.round(performance.now() - t0) }); }
    catch (err) { tests.push({ id, name, pass: false, evidence: `threw: ${err instanceof MoshpitError ? JSON.stringify(err.toJSON()) : (err as Error)?.stack ?? err}` }); }
    free();
    const r = tests[tests.length - 1];
    log(`[gate] ${r.pass ? 'PASS' : 'FAIL'} ${id} (${r.ms ?? '-'} ms)${r.pass ? '' : ' ' + r.evidence.slice(0, 400)}`);
  }
  if (!only.length || only.includes('control')) notes.push(await naiveControl(doc));
  free();
  if (!only.length || only.includes('alloc')) notes.push(await allocProbe(doc));
  free();
  return { tests, notes, env };
}

/** Negative control (not a gate case): the same timeline without frame_num renumbering, on Chromium's decoder. */
async function naiveControl(doc: ProjectDoc): Promise<string> {
  const e = mk(doc);
  const plan = (e as unknown as { plan: { samples: { rewrite: boolean }[] } }).plan;
  const rewritten = plan.samples.filter((s) => s.rewrite).length;
  for (const s of plan.samples) s.rewrite = false;
  let code = 'none';
  try { await e.renderRange(0, e.hashes.length - 1, { hash: false }); } catch (err) { code = err instanceof MoshpitError ? err.code : String(err); }
  return `CONTROL  naive splice (no frame_num renumber, ${rewritten} samples needed it): Chromium withheld ${e.stats.orderErrors} frames, engine raised ${code}`;
}

async function allocProbe(doc: ProjectDoc): Promise<string> {
  const e = mk(doc);
  const N = e.hashes.length, W = 3;
  await e.renderRange(0, N - 1, { hash: true });
  const out: { bpf: number; fps: number; top: unknown }[] = [];
  for (let k = 0; k < W; k++) {
    await ipcRenderer.invoke('heap', 'start');
    const t = performance.now();
    await e.renderRange(0, N - 1, { hash: true });
    const ms = performance.now() - t;
    const r = await ipcRenderer.invoke('heap', 'stop');
    out.push({ bpf: +(r.total / N).toFixed(1), fps: +(N / (ms / 1000)).toFixed(0), top: r.top.slice(0, 4) });
  }
  (globalThis as { gc?: () => void }).gc?.();
  const h0 = (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
  for (let k = 0; k < 3; k++) await e.renderRange(0, N - 1, { hash: true });
  (globalThis as { gc?: () => void }).gc?.();
  const h1 = (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
  fs.writeFileSync(path.join(OUT, 'gate-alloc.json'), JSON.stringify(out, null, 2));
  return `ALLOC  full loop (decode→GPU graph→readback→hash), B/frame per window ${JSON.stringify(out.map((o) => o.bpf))} at ${out[W - 1].fps} fps; retained heap after GC over 3×${N} frames: ${h1 - h0} B; top sites in gate-alloc.json`;
}
