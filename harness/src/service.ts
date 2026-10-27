// Contract test for the EngineClient seam, against the real EngineService, no UI. Everything
// the UI lane's mock promises, the real engine must do: import with progress, frames for each
// target kind with honest EXACT/PROXY labels, chapters, freeze with fresh/stale badges, export
// with progress and the overwrite guard, per-clip audio peaks, structured errors.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcRenderer } from 'electron';
import { EngineService } from '../../engine/src/service/service';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { MoshpitError } from '../../engine/src/errors';
import type { ProjectDoc, SourceId } from '../../engine/src/model';
import type { ConformUpdate } from '../../engine/src/client';
import { OUT, ROOT } from './fixtures';
import type { TestResult } from './gate';

const log = (m: string) => ipcRenderer.send('log', m);
const DIR = path.join(OUT, 'service');

export async function runService(): Promise<{ tests: TestResult[]; notes: string[] }> {
  fs.rmSync(DIR, { recursive: true, force: true });
  const tests: TestResult[] = [];
  const check = async (id: string, name: string, fn: () => Promise<{ pass: boolean; evidence: string }>) => {
    const t0 = performance.now();
    try { tests.push({ id, name, ...(await fn()), ms: Math.round(performance.now() - t0) }); }
    catch (e) { tests.push({ id, name, pass: false, evidence: `threw: ${e instanceof MoshpitError ? JSON.stringify(e.toJSON()) : (e as Error)?.stack ?? e}` }); }
    const r = tests[tests.length - 1];
    log(`[service] ${r.pass ? 'PASS' : 'FAIL'} ${id} ${name}${r.pass ? '' : ' ' + r.evidence.slice(0, 300)}`);
  };
  const svc = new EngineService({ cacheDir: path.join(DIR, 'cache'), libraryRoots: [path.join(ROOT, 'fixtures')] });
  const doc: ProjectDoc = newProject('service', { working: { w: 640, h: 360 } });
  svc.updateProject(doc);

  await check('C1', 'nodeDefs and library listing', async () => {
    const defs = svc.nodeDefs();
    const folders = await svc.libraryFolders();
    const clips = await svc.libraryClips(folders[0].path);
    return { pass: defs.some((d) => d.kind === 'fx.feedback') && folders[0].count >= 4 && clips.every((c) => c.pass === true), evidence: `${defs.length} defs; library root has ${folders[0].count} clips, all probed: ${clips.map((c) => `${c.name} ${c.probe.codec} ${c.probe.width}x${c.probe.height}`).join(', ')}` };
  });

  await check('C2', 'proxy-first import: usable on the proxy at once, EXACT waits for the master, READY swaps it in', async () => {
    const stages = new Set<string>();
    let maxFrac = 0;
    const updates: ConformUpdate[] = [];
    const off = svc.onConformUpdate((u) => updates.push(u));
    const t0 = performance.now();
    for (const name of ['src-a.mp4', 'src-c.mp4']) {
      const r = await svc.importClip(path.join(ROOT, 'fixtures', name), (p) => { stages.add(p.stage); if (p.stage === 'proxy') maxFrac = Math.max(maxFrac, p.fraction); });
      doc.resources.sources.push(r.source);
      doc.resources.conforms.push(r.conform);
    }
    const proxyMs = performance.now() - t0;
    const [A, C] = doc.resources.sources;
    doc.timeline.blocks = [withChain(newBlock('picture', A.id, 0, 120), [{ kind: 'fx.plane-desync', params: { dx: 50 } }, { kind: 'fx.feedback' }]), newBlock('motion', C.id, 10, 130)];
    svc.updateProject(doc);
    const statuses = doc.resources.conforms.map((c) => c.status);
    // While mastering: a large frame still renders, from the proxy, labelled as such.
    const early = await svc.frame({ kind: 'output', frame: 150 }, { w: 640, h: 360 });
    const pendingAtFrame = svc.conformStates().filter((u) => u.state !== 'READY').length;
    // Wait for both masters, then store the ready records the way the UI will.
    await new Promise<void>((res) => { const tick = () => (svc.conformStates().every((u) => u.state === 'READY') ? res() : setTimeout(tick, 50)); tick(); });
    const readyMs = performance.now() - t0;
    for (const u of svc.conformStates()) { const i = doc.resources.conforms.findIndex((c) => c.sourceId === u.sourceId); doc.resources.conforms[i] = u.conform!; }
    svc.updateProject(doc);
    off();
    const late = await svc.frame({ kind: 'output', frame: 150 }, { w: 640, h: 360 });
    const order = (id: SourceId) => updates.filter((u) => u.sourceId === id).map((u) => u.state).filter((x, i, a) => a.indexOf(x) === i).join('→');
    const pass = [...stages].join() === 'probe,proxy' && maxFrac > 0.9 && statuses.every((x) => x === 'proxy')
      && (pendingAtFrame === 0 || (early.state === 'PROXY' && early.route.includes('finalizing conform')))
      && late.state === 'EXACT' && doc.resources.conforms.every((c) => c.status === 'ready' && !!c.conformedHash)
      && [A.id, C.id].every((id) => order(id) === 'PROXY_READY→MASTERING→READY');
    return { pass, evidence: `stages ${[...stages].join(' → ')}; both clips usable after ${proxyMs.toFixed(0)} ms (records ${statuses.join(', ')}), masters ready after ${readyMs.toFixed(0)} ms; a 640×360 frame while ${pendingAtFrame} master(s) pending: ${early.state} "${early.route}"; after READY: ${late.state} "${late.route}"; updates ${order(A.id)} / ${order(C.id)}` };
  });

  await check('C3', 'frames: output, source, per-node viewer; proxy for small, exact for large', async () => {
    const small = await svc.frame({ kind: 'output', frame: 150 }, { w: 160, h: 90 });
    const big = await svc.frame({ kind: 'output', frame: 150 }, { w: 640, h: 360 });
    const src = await svc.frame({ kind: 'source', sourceId: doc.resources.sources[0].id, frame: 120 }, { w: 640, h: 360 });
    const b0 = doc.timeline.blocks[0];
    const pd = b0.graph.nodes.find((n) => n.kind === 'fx.plane-desync')!;
    const viewer = await svc.frame({ kind: 'node', blockId: b0.id, nodeId: pd.id, frame: 60 }, { w: 640, h: 360 });
    const outAt60 = await svc.frame({ kind: 'output', frame: 60 }, { w: 640, h: 360 });
    const differs = Buffer.compare(Buffer.from(viewer.data), Buffer.from(outAt60.data)) !== 0;
    const pass = small.state === 'PROXY' && small.w === 160 && big.state === 'EXACT' && big.w === 640 && src.route.startsWith('I-frame') && differs && big.route.includes('moshed');
    return { pass, evidence: `160 px → ${small.state} ${small.w}×${small.h}; 640 px → ${big.state} ${big.w}×${big.h} (${big.route}); source frame 120: ${src.route}; viewer on Plane desync differs from the block output (feedback after it): ${differs}` };
  });

  await check('C4', 'detectCuts returns chapters on the conform\'s frames', async () => {
    const ch = await svc.detectCuts(doc.resources.sources[0].id, 0.5);
    return { pass: ch.length === 1 && ch[0].start === 0 && ch[0].end === 300, evidence: `${ch.length} chapter(s): ${ch.map((c) => `[${c.start},${c.end})`).join(' ')} (a single-shot test pattern has no cuts)` };
  });

  await check('C5', 'freeze → fresh badge → edit → stale badge, still plays', async () => {
    const b1 = doc.timeline.blocks[1];
    const rec = await svc.freeze({ kind: 'block', blockId: b1.id }, [120, 239]);
    doc.freezes.push(rec);
    svc.updateProject(doc);
    const fresh = await svc.frame({ kind: 'output', frame: 200 }, { w: 640, h: 360 });
    const edited = structuredClone(doc);
    edited.timeline.blocks[1] = { ...edited.timeline.blocks[1], in: 12, out: 132 };
    svc.updateProject(edited);
    const stale = await svc.frame({ kind: 'output', frame: 200 }, { w: 640, h: 360 });
    const samePixels = Buffer.compare(Buffer.from(fresh.data), Buffer.from(stale.data)) === 0;
    svc.updateProject(doc);
    return { pass: fresh.freeze === 'fresh' && stale.freeze === 'stale' && samePixels, evidence: `record key ${rec.key.slice(0, 12)}…; after freeze: ${fresh.freeze}; after an upstream slice edit: ${stale.freeze}, still playing the frozen pixels: ${samePixels}` };
  });

  await check('C6', 'render job with progress; refuses to overwrite', async () => {
    const out = path.join(DIR, 'job.mp4');
    const fr: number[] = [];
    await svc.render({ id: 'j1', name: 'job', config: { format: 'mp4-h264', width: 640, height: 360, audio: true }, outPath: out }, (p) => fr.push(p.fraction));
    let code = '';
    try { await svc.render({ id: 'j2', name: 'job', config: { format: 'mp4-h264', width: 640, height: 360, audio: true }, outPath: out }, () => {}); } catch (e) { code = (e as MoshpitError).code; }
    return { pass: fs.statSync(out).size > 0 && fr[fr.length - 1] === 1 && fr.length > 5 && code === 'EXPORT_EXISTS', evidence: `${fs.statSync(out).size} B, ${fr.length} progress events ending at ${fr[fr.length - 1]}; second render raised ${code}` };
  });

  await check('C11', 'export before the master is done: queued, waits, then byte-identical to an export with the master ready', async () => {
    const svc2 = new EngineService({ cacheDir: path.join(DIR, 'cache-c11') });
    const d2: ProjectDoc = newProject('c11', { working: { w: 640, h: 360 } });
    svc2.updateProject(d2);
    const r = await svc2.importClip(path.join(ROOT, 'fixtures', 'src-b.mp4'));
    d2.resources.sources.push(r.source); d2.resources.conforms.push(r.conform);
    d2.timeline.blocks = [withChain(newBlock('picture', r.source.id, 0, 90), [{ kind: 'fx.plane-desync', params: { dx: 30 } }]), newBlock('motion', r.source.id, 120, 200)];
    svc2.updateProject(d2);
    const stateAtExport = svc2.conformStates()[0].state;
    const logs: string[] = [];
    const a = path.join(DIR, 'c11-early.mp4'), b = path.join(DIR, 'c11-ready.mp4');
    await svc2.render({ id: 'e', name: 'early', config: { format: 'mp4-h264', width: 640, height: 360, audio: true }, outPath: a }, (p) => { if (p.log) logs.push(p.log.text); });
    d2.resources.conforms[0] = svc2.conformStates()[0].conform!;
    svc2.updateProject(d2);
    await svc2.render({ id: 'r', name: 'ready', config: { format: 'mp4-h264', width: 640, height: 360, audio: true }, outPath: b }, () => {});
    svc2.dispose();
    const same = fs.readFileSync(a).equals(fs.readFileSync(b));
    const waited = logs.some((l) => l.startsWith('waiting for'));
    return { pass: same && (stateAtExport === 'READY' || waited), evidence: `master was ${stateAtExport} when export started; log: ${logs.slice(0, 3).join(' | ')}; early vs ready export ${same ? 'byte-identical' : 'DIFFER'} (${fs.statSync(a).size} B)` };
  });

  await check('C7', 'audioPeaks per clip (L27)', async () => {
    const a = await svc.audioPeaks(doc.resources.sources[0].id, 50);
    const c = await svc.audioPeaks(doc.resources.sources[1].id, 50);
    // lavfi's sine source has amplitude 1/8, so a steady ~0.1 peak is the clip's real level.
    return { pass: a.length === 50 && Math.min(...a.slice(1, 49)) > 0.05 && Math.max(...a) - Math.min(...a.slice(1, 49)) < 0.05 && Math.max(...c) === 0, evidence: `clip A (sine, amplitude 1/8): peaks ${Math.min(...a).toFixed(2)}–${Math.max(...a).toFixed(2)}; clip C (no audio): all zero` };
  });

  await check('C9', 'scrub cache (audit S4): background fill turns a moshed scrub into cache reads', async () => {
    const at = 200, sz = { w: 640, h: 360 };
    const t0 = performance.now();
    await svc.frame({ kind: 'output', frame: at }, sz);
    const cold = performance.now() - t0;
    let chunks = 0;
    while (await svc.idle()) chunks++;
    const t1 = performance.now();
    const got: Uint8Array[] = [];
    for (let f = at; f > at - 20; f--) got.push((await svc.frame({ kind: 'output', frame: f }, sz)).data);
    const warm = (performance.now() - t1) / 20;
    // Correctness: a cached frame equals the same frame rendered by a service with no cache.
    const ref = new EngineService({ cacheDir: path.join(DIR, 'cache-ref'), frameCacheBytes: 0 });
    ref.updateProject(doc);
    const r = await ref.frame({ kind: 'output', frame: at - 7 }, sz);
    ref.dispose();
    const equal = Buffer.compare(Buffer.from(r.data), Buffer.from(got[7])) === 0;
    return { pass: warm < cold / 5 && equal && chunks > 0, evidence: `cold frame ${cold.toFixed(0)} ms; ${chunks} idle fill chunks; then 20 backward steps at ${warm.toFixed(1)} ms/step (${(cold / warm).toFixed(0)}× faster); a cached frame equals an uncached render: ${equal}` };
  });

  await check('C10', 'D7: re-conform and compare against the pinned record', async () => {
    const same = await svc.verifyConforms();
    const tampered = structuredClone(doc);
    tampered.resources.conforms[0] = { ...tampered.resources.conforms[0], conformedHash: 'f'.repeat(64) };
    svc.updateProject(tampered);
    const diff = await svc.verifyConforms();
    svc.updateProject(doc);
    return { pass: same.every((r) => r.status === 'same') && diff[0].status === 'changed' && diff[0].error?.code === 'CONFORM_CHANGED', evidence: `fresh re-conforms match their pinned hashes: ${same.map((r) => r.status).join(', ')}; a pinned record whose hash no longer matches → ${diff[0].status} (${diff[0].error?.code})` };
  });

  await check('C8', 'failures are structured errors with codes', async () => {
    const bad = structuredClone(doc);
    bad.timeline.blocks[0].graph.edges = [];
    svc.updateProject(bad);
    let c1 = '', c2 = '';
    try { await svc.frame({ kind: 'output', frame: 0 }, { w: 640, h: 360 }); } catch (e) { c1 = (e as MoshpitError).code; }
    try { await svc.importClip(path.join(ROOT, 'fixtures', 'missing.mp4')); } catch (e) { c2 = (e as MoshpitError).code; }
    svc.updateProject(doc);
    return { pass: c1 === 'GRAPH_REQUIRED_INPUT' && c2 === 'MEDIA_FILE_MISSING', evidence: `unwired block graph → ${c1}; missing file → ${c2}` };
  });

  svc.dispose();
  return { tests, notes: [] };
}
