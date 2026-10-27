import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ipcRenderer } from 'electron';
import { EngineService } from '../../engine/src/service/service';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { liveBackends } from '../../engine/src/gpu/backend';
import { probe } from '../../engine/src/conform/conform';

const out = process.env.AUDIT_ENGINE_OUT!;
const input = process.env.AUDIT_ENGINE_INPUT!;
const ffmpeg = process.env.AUDIT_ENGINE_FFMPEG!;
const hash = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');
const tests: { name: string; pass: boolean; evidence: unknown }[] = [];
const log = (text: string) => ipcRenderer.send('audit-log', text);
function check(name: string, pass: boolean, evidence: unknown) {
  tests.push({ name, pass, evidence }); log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(evidence)}`);
}
const started = Date.now();
const result: Record<string, unknown> = { tests, input, ffmpeg, started: new Date().toISOString() };
let svc: EngineService | undefined;
window.addEventListener('error', event => log('Renderer error: ' + event.message));
window.addEventListener('unhandledrejection', event => log('Unhandled rejection: ' + String(event.reason)));
const heartbeat = setInterval(() => log('Engine audit alive: ' + JSON.stringify(svc?.conformStates().map(s => ({ state: s.state, fraction: s.fraction, error: s.error })))), 10000);
(async () => {
  try {
    result.inputSha256Before = hash(fs.readFileSync(input));
    svc = new EngineService({ cacheDir: path.join(out, 'cache'), ffmpeg, libraryRoots: [path.dirname(input)], budgetBytes: 128 << 20, frameCacheBytes: 16 << 20 });
    const doc = newProject('Isolated engine acceptance', { working: { w: 320, h: 180 }, fps: { num: 30, den: 1 } });
    svc.updateProject(doc);
    const stages: string[] = [];
    log('Importing 2-second generated fixture slice at 320x180');
    const imported = await svc.importClip(input, p => { if (!stages.includes(p.stage)) { stages.push(p.stage); log('Import stage: ' + p.stage); } }, undefined, { range: { startSec: 0, durSec: 2 } });
    log('Proxy import resolved; waiting for background master');
    const masterDeadline = Date.now() + 60000;
    while (imported.conform.status === 'proxy') {
      const state = svc.conformStates().find(s => s.sourceId === imported.source.id);
      if (state?.state === 'FAILED') throw new Error('Master failed: ' + JSON.stringify(state.error));
      if (state?.state === 'READY' && state.conform) { imported.conform = state.conform; break; }
      if (Date.now() >= masterDeadline) throw new Error('Background master wait exceeded 60 seconds');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    doc.resources.sources.push(imported.source); doc.resources.conforms.push(imported.conform);
    check('real import and master conform', imported.conform.frames === 60 && imported.conform.status === 'ready', { stages, frames: imported.conform.frames, status: imported.conform.status, sourceRange: imported.source.range });
    const repeated = withChain(newBlock('picture', imported.source.id, 0, 24, { repeat: 2 }), [{ kind: 'fx.invert', params: { amount: 100 } }]);
    doc.timeline.blocks = [repeated, newBlock('motion', imported.source.id, 10, 34)];
    svc.updateProject(doc);
    const exact = await svc.frame({ kind: 'output', frame: 30 }, { w: 320, h: 180 });
    const proxy = await svc.frame({ kind: 'output', frame: 55 }, { w: 80, h: 45 });
    const motion = await svc.frame({ kind: 'output', frame: 55 }, { w: 320, h: 180 });
    check('real decoded GPU frames', exact.state === 'EXACT' && proxy.state === 'PROXY' && exact.data.length === 320 * 180 * 4 && motion.route.includes('moshed'), { exact: { state: exact.state, route: exact.route, sha256: hash(exact.data) }, proxy: { state: proxy.state, route: proxy.route, sha256: hash(proxy.data) }, motion: { state: motion.state, route: motion.route, sha256: hash(motion.data) }, gpu: [...liveBackends].map(b => b.gpuName) });
    log('Freezing whole repeated block, frames 0 through 47');
    const rec = await svc.freeze({ kind: 'block', blockId: repeated.id }, [0, 47]);
    doc.freezes.push(rec); svc.updateProject(doc);
    const frozen = await svc.frame({ kind: 'output', frame: 30 }, { w: 320, h: 180 });
    check('repeat x2 freeze matches live pixels', frozen.freeze === 'fresh' && hash(frozen.data) === hash(exact.data), { range: rec.range, key: rec.key, freeze: frozen.freeze, sha256: hash(frozen.data) });
    const changed = structuredClone(doc); changed.freezes = [];
    changed.timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.invert')!.params.amount = 0;
    svc.updateProject(changed);
    const unfrozen = await svc.frame({ kind: 'output', frame: 30 }, { w: 320, h: 180 });
    check('unfreeze and parameter edit change real pixels', !unfrozen.freeze && hash(unfrozen.data) !== hash(frozen.data), { freeze: unfrozen.freeze ?? 'none', sha256: hash(unfrozen.data) });
    const output = path.join(out, 'render-72frames.mp4');
    const fractions: number[] = [];
    log('Rendering 72 frames to a new audit-owned MP4');
    await svc.render({ id: 'audit-render', name: 'Audit render', doc: changed, outPath: output, config: { format: 'mp4-h264', width: 320, height: 180, audio: false } }, p => { fractions.push(p.fraction); if (p.log) log(p.log.text); });
    const metadata = await probe(output, ffmpeg);
    check('real ffmpeg output metadata and completion', metadata.frames === 72 && metadata.width === 320 && metadata.height === 180 && fractions.at(-1) === 1, { bytes: fs.statSync(output).size, sha256: hash(fs.readFileSync(output)), metadata, progressEvents: fractions.length });
    let overwrite = '';
    try { await svc.render({ id: 'audit-repeat', name: 'Audit repeat', doc: changed, outPath: output, config: { format: 'mp4-h264', width: 320, height: 180, audio: false } }, () => {}); }
    catch (error) { overwrite = (error as { code?: string }).code ?? String(error); }
    check('output overwrite guard', overwrite === 'EXPORT_EXISTS', overwrite);
    result.output = output;
    result.inputSha256After = hash(fs.readFileSync(input));
    check('input preserved byte-for-byte', result.inputSha256Before === result.inputSha256After, result.inputSha256After);
  } catch (error) {
    result.fatal = (error as Error).stack || String(error);
    result.error = typeof (error as { toJSON?: () => unknown }).toJSON === 'function' ? (error as { toJSON: () => unknown }).toJSON() : undefined;
  } finally {
    clearInterval(heartbeat);
    try { svc?.dispose(); } catch (error) { result.disposeError = String(error); }
    result.elapsedMs = Date.now() - started;
    ipcRenderer.send('audit-done', result);
  }
})();
