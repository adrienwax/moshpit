// Isolated, short real-GPU 1080p60 acceptance; no installed profile, CT, or freeze files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ipcRenderer } from 'electron';
import { EngineService } from '../../engine/src/service/service';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { liveBackends } from '../../engine/src/gpu/backend';
import { probe } from '../../engine/src/conform/conform';
import { demux } from '../../engine/src/bitstream/mp4';

const out = process.env.AUDIT_ENGINE_OUT!, input = process.env.AUDIT_ENGINE_INPUT!, ffmpeg = process.env.AUDIT_ENGINE_FFMPEG!;
const hash = (data: Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');
const tests: { name: string; pass: boolean; evidence: unknown }[] = [];
const log = (text: string) => ipcRenderer.send('audit-log', text);
const check = (name: string, pass: boolean, evidence: unknown) => { tests.push({ name, pass, evidence }); log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(evidence)}`); };
const start = Date.now(), result: Record<string, unknown> = { tests, input, ffmpeg, started: new Date().toISOString(), scope: '24-frame isolated engine smoke, not installed UI or physical-device acceptance' };
let svc: EngineService | undefined;
(async () => {
  try {
    result.inputSha256Before = hash(fs.readFileSync(input));
    const original = await probe(input, ffmpeg);
    if (original.width !== 1920 || original.height !== 1080 || original.fps.num / original.fps.den !== 60) throw new Error('Expected generated 1080p60 test card');
    svc = new EngineService({ cacheDir: path.join(out, 'cache'), ffmpeg, libraryRoots: [path.dirname(input)], budgetBytes: 256 << 20, frameCacheBytes: 16 << 20 });
    const doc = newProject('Isolated C5 HD60 audit', { working: { w: 1920, h: 1080 }, fps: { num: 60, den: 1 } });
    svc.updateProject(doc);
    log('Importing 0.4-second 1080p60 slice');
    const imported = await svc.importClip(input, undefined, undefined, { proxyFirst: false, range: { startSec: 0, durSec: .4 } });
    doc.resources.sources.push(imported.source); doc.resources.conforms.push(imported.conform);
    const master = demux(imported.conform.path);
    check('1080p60 ready master conform declares level 4.2', imported.conform.status === 'ready' && imported.conform.frames === 24 && master.width === 1920 && master.height === 1080 && master.fps.num / master.fps.den === 60 && master.sps?.levelIdc === 42,
      { status: imported.conform.status, frames: imported.conform.frames, width: master.width, height: master.height, fps: master.fps, level: master.sps?.levelIdc, codec: master.codecString });
    const clean = newBlock('picture', imported.source.id, 0, 24);
    doc.timeline.blocks = [clean]; svc.updateProject(doc);
    const before = await svc.frame({ kind: 'output', frame: 7 }, { w: 1920, h: 1080, quality: 'full' });
    doc.timeline.blocks = [withChain(clean, [{ kind: 'fx.invert', params: { amount: 100 } }])]; svc.updateProject(doc);
    const effected = await svc.frame({ kind: 'output', frame: 7 }, { w: 1920, h: 1080, quality: 'full' });
    check('GPU effect changes full 1920x1080 master pixels', before.state === 'EXACT' && effected.state === 'EXACT' && effected.w === 1920 && effected.h === 1080 && effected.data.length === 1920 * 1080 * 4 && hash(before.data) !== hash(effected.data),
      { before: hash(before.data), effected: hash(effected.data), route: effected.route, gpu: [...liveBackends].map(b => b.gpuName) });
    const smallFull = await svc.frame({ kind: 'output', frame: 7 }, { w: 320, h: 180, quality: 'full' });
    const smallAuto = await svc.frame({ kind: 'output', frame: 7 }, { w: 320, h: 180, quality: 'auto' });
    check('Full stays master in a 320px viewer while Auto uses proxy', smallFull.state === 'EXACT' && smallFull.w === 1920 && smallFull.h === 1080 && hash(smallFull.data) === hash(effected.data) && smallAuto.state === 'PROXY' && smallAuto.w === 480 && smallAuto.h === 270,
      { full: { width: smallFull.w, height: smallFull.h, state: smallFull.state, route: smallFull.route }, auto: { width: smallAuto.w, height: smallAuto.h, state: smallAuto.state, route: smallAuto.route } });
    fs.writeFileSync(path.join(out, 'project.json'), JSON.stringify(doc, null, 2));
    const output = path.join(out, 'hd60-effect-24frames.mp4');
    let finished = false;
    log('Exporting 24 effected frames at full 1080p60');
    await svc.render({ id: 'audit-hd60', name: 'HD60 GPU smoke', doc, outPath: output, config: { format: 'mp4-h264', width: 1920, height: 1080, audio: false } }, p => { if (p.fraction === 1) finished = true; if (p.log) log(p.log.text); });
    const metadata = await probe(output, ffmpeg);
    const decoded = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', output, '-f', 'framemd5', '-'], { maxBuffer: 4 << 20, windowsHide: true });
    const hashes = String(decoded.stdout).split('\n').filter(line => line.trim() && !line.startsWith('#'));
    fs.writeFileSync(path.join(out, 'export-framemd5.txt'), decoded.stdout);
    check('export completes at 1920x1080 60fps and independently decodes all 24 frames', finished && metadata.width === 1920 && metadata.height === 1080 && metadata.frames === 24 && metadata.fps.num / metadata.fps.den === 60 && decoded.status === 0 && !String(decoded.stderr).trim() && hashes.length === 24,
      { metadata, bytes: fs.statSync(output).size, sha256: hash(fs.readFileSync(output)), decodedFrames: hashes.length, ffmpegStatus: decoded.status, stderr: String(decoded.stderr) });
    result.output = output;
  } catch (error) { result.fatal = (error as Error).stack || String(error); }
  finally {
    try { svc?.dispose(); } catch (error) { result.disposeError = String(error); }
    result.inputSha256After = hash(fs.readFileSync(input));
    check('source preserved byte-for-byte', result.inputSha256Before === result.inputSha256After, result.inputSha256After);
    result.elapsedMs = Date.now() - start;
    ipcRenderer.send('audit-done', result);
  }
})();
