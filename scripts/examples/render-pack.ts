// Runs only in the build-time private Electron renderer; actual Moshpit effects produce previews.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ipcRenderer } from 'electron';
import { EngineService } from '../../engine/src/service/service';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { parseProject, serializeProject } from '../../engine/src/project/io';
import { blockSpanFrames } from '../../engine/src/timeline/length';
import { probe } from '../../engine/src/conform/conform';
import type { ProjectDoc } from '../../engine/src/model';

const out = process.env.MOSHPIT_EXAMPLE_OUT!, work = process.env.MOSHPIT_EXAMPLE_WORK!, ffmpeg = process.env.MOSHPIT_FFMPEG!;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const log = (message: string) => ipcRenderer.send('example-log', message);
const result: { status: string; checks: unknown[]; error?: string } = { status: 'RUNNING', checks: [] };
let service: EngineService | undefined;

function portable(value: unknown, aliases: Map<string, string>): unknown {
  if (typeof value === 'string') {
    const key = path.resolve(value);
    if (aliases.has(key)) return 'pack://' + aliases.get(key);
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) throw Error('Unmapped absolute path in public project');
    return value;
  }
  if (Array.isArray(value)) return value.map(v => portable(v, aliases));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portable(v, aliases)]));
  return value;
}

(async () => {
  try {
    service = new EngineService({ cacheDir: path.join(work, 'engine-cache'), ffmpeg, libraryRoots: [path.join(out, 'media')], budgetBytes: 256 << 20, frameCacheBytes: 32 << 20 });
    const base = newProject('Starter studies', { working: { w: 640, h: 360 }, fps: { num: 30, den: 1 }, bpm: 120, seed: 4242, timeDisplay: 'frames' });
    base.exportConfig.audio = false;
    service.updateProject(base);
    const aliases = new Map<string, string>();
    for (const name of ['ribbons', 'orbit']) {
      log(`Import and conform ${name}`);
      const input = path.join(out, 'media', `${name}.mp4`);
      const imported = await service.importClip(input, undefined, undefined, { proxyFirst: false });
      if (imported.conform.status !== 'ready' || imported.conform.frames !== 240 || !imported.conform.moshable) throw Error('Source conform not ready/moshable at 240 frames');
      base.resources.sources.push(imported.source); base.resources.conforms.push(imported.conform);
      aliases.set(path.resolve(input), `media/${name}.mp4`);
      for (const [kind, file] of [['master', imported.conform.path], ['proxy', imported.conform.proxy?.path]] as const) {
        if (!file) throw Error('Missing conformed media');
        const relative = `media/${name}-${kind}.mp4`;
        fs.copyFileSync(file, path.join(out, relative), fs.constants.COPYFILE_EXCL);
        aliases.set(path.resolve(file), relative);
      }
      result.checks.push({ source: name, frames: imported.conform.frames, moshable: imported.conform.moshable });
    }
    const [a, b] = base.resources.sources;
    const specs = [
      { id: 'starter-texture-carry', title: 'Texture carry / clean reset', group: 'pixelord', hint: 'Switch the middle block between Motion and Picture; watch the carry turn into a clean cut.', blocks: [newBlock('picture', a.id, 0, 60), newBlock('motion', b.id, 12, 132), newBlock('picture', b.id, 132, 192)] },
      { id: 'starter-p-frame-replay', title: 'Replay one P-frame', group: 'pixelord', hint: 'Select Hold and change Times. Repeating an encoded motion update can drift the image instead of freezing it.', blocks: [withChain(newBlock('picture', a.id, 0, 210), [{ kind: 'mosh.hold', params: { at: 38, span: 1, times: 31, winFrom: 33, winLen: 2 } }])] },
      { id: 'starter-chroma-ghost', title: 'Chroma ghost', group: 'mix', hint: 'Change Back or Wet on Chroma trail. Colour channels lag behind moving shapes.', blocks: [withChain(newBlock('picture', b.id, 0, 240), [{ kind: 'fx.plane-desync-temporal', params: { pastR: true, pastG: false, pastB: true, back: 5, wet: 1 } }, { kind: 'fx.chroma-trail', params: { amount: 70, back: 2, spread: 80, wet: .8 } }])] },
      { id: 'starter-breathing-feedback', title: 'Breathing feedback', group: 'mix', hint: 'Open Modulation and change Breathing trail period. Its LFO animates Feedback trail Amount.', blocks: [withChain(newBlock('picture', a.id, 0, 240), [{ kind: 'fx.feedback-trail', params: { amount: 45, back: 2, wet: 1 } }, { kind: 'fx.echo-taps', params: { amount: 45, taps: 3, spacing: 3, decay: 60, wet: .7 } }])] },
    ];
    const examples = [];
    for (const spec of specs) {
      const doc = structuredClone(base); doc.id = crypto.randomUUID() as ProjectDoc['id']; doc.name = spec.title; doc.timeline.blocks = spec.blocks;
      if (spec.id === 'starter-breathing-feedback') {
        const lfo = doc.modulators.lfos[0]; lfo.label = 'Breathing trail'; lfo.period = 4;
        doc.timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.feedback-trail')!.bindings.amount = { lfo: { lfoId: lfo.id, depth: .5, op: 'add' } };
      }
      service.updateProject(doc);
      const frames = doc.timeline.blocks.reduce((sum, block) => sum + blockSpanFrames(block) * block.repeat, 0);
      if (frames < 180 || frames > 300) throw Error(`Unexpected example length: ${spec.id} ${frames}`);
      const first = await service.frame({ kind: 'output', frame: 15 }, { w: 640, h: 360 });
      const later = await service.frame({ kind: 'output', frame: 95 }, { w: 640, h: 360 });
      if (hash(first.data) === hash(later.data)) throw Error(`Example did not move: ${spec.id}`);
      const preview = `previews/${spec.id}.mp4`;
      log(`Render ${spec.title} (${frames} frames)`);
      await service.render({ id: spec.id, name: spec.title, doc, outPath: path.join(out, preview), config: { format: 'mp4-h264', width: 640, height: 360, audio: false } }, p => { if (p.log?.level === 'warn') log(p.log.text); });
      const metadata = await probe(path.join(out, preview), ffmpeg);
      if (metadata.frames !== frames || metadata.width !== 640 || metadata.height !== 360) throw Error(`Preview metadata mismatch: ${spec.id}`);
      const file = `projects/${spec.id}.mosh`;
      const portableDoc = portable(doc, aliases) as ProjectDoc;
      const serialized = serializeProject(portableDoc); parseProject(serialized);
      fs.writeFileSync(path.join(out, file), serialized, { flag: 'wx' });
      examples.push({ id: spec.id, title: spec.title, group: spec.group, file, preview, seconds: frames / 30, hint: spec.hint });
      result.checks.push({ id: spec.id, frames, movingFramesDiffer: true, engineRender: true, preview: metadata, projectSha256: hash(Buffer.from(serialized)) });
    }
    fs.writeFileSync(path.join(work, 'example-rows.json'), JSON.stringify(examples, null, 2), { flag: 'wx' });
    result.status = 'PASS';
  } catch (error) { result.status = 'FAIL'; result.error = (error as Error).stack || String(error); }
  finally { try { service?.dispose(); } catch (error) { result.status = 'FAIL'; result.error = String(error); } ipcRenderer.send('example-done', result); }
})();
