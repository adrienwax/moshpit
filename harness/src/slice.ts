// The M1 vertical slice, end to end on the real stack:
//   import → conform → scene-detect → slice (marks + a chapter) → mosh → GPU effects → freeze
//   → cold seeks → export (MP4 + audio, HAP) → independent decode check → save → load → re-render.
// Every step asserts something; nothing is eyeballed.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcRenderer } from 'electron';
import { conform, probe, sourceHash } from '../../engine/src/conform/conform';
import { detectCuts, chaptersFromCuts } from '../../engine/src/conform/scenes';
import { findFfmpeg, run } from '../../engine/src/conform/ffmpeg';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { loadProjectFile, saveProjectFile } from '../../engine/src/project/io';
import { compileProject, engineOptions } from '../../engine/src/runtime/session';
import { Engine } from '../../engine/src/runtime/engine';
import { exportRange } from '../../engine/src/runtime/export';
import { AudioClock, RationalClock } from '../../engine/src/time/clock';
import { MoshpitError } from '../../engine/src/errors';
import type { FreezeId, MarkId, ProjectDoc, SourceClip, SourceId } from '../../engine/src/model';
import { newId } from '../../engine/src/model';
import { OUT, ROOT, SETTINGS } from './fixtures';
import type { TestResult } from './gate';

const log = (m: string) => ipcRenderer.send('log', m);
const DIR = path.join(OUT, 'slice');

export async function runSlice(): Promise<{ tests: TestResult[]; notes: string[] }> {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const tests: TestResult[] = [];
  const notes: string[] = [];
  const step = async (id: string, name: string, fn: () => Promise<{ pass: boolean; evidence: string }>) => {
    const t0 = performance.now();
    try { tests.push({ id, name, ...(await fn()), ms: Math.round(performance.now() - t0) }); }
    catch (e) { tests.push({ id, name, pass: false, evidence: `threw: ${e instanceof MoshpitError ? JSON.stringify(e.toJSON()) : (e as Error)?.stack ?? e}` }); }
    const r = tests[tests.length - 1];
    log(`[slice] ${r.pass ? 'PASS' : 'FAIL'} ${id} ${name} (${r.ms ?? '-'} ms)${r.pass ? '' : ' ' + r.evidence.slice(0, 300)}`);
    if (!r.pass) throw new Error(`stopped at ${id}`);
  };

  const doc: ProjectDoc = newProject('vertical slice', { working: { w: SETTINGS.width, h: SETTINGS.height } });
  doc.settings.seed = 777;
  const ids: Record<string, SourceId> = {};
  try {
    // 1. Import: probe → conform (L29) with progress → keyframe-locked proxy.
    await step('S1', 'Import and conform three sources', async () => {
      const lines: string[] = [];
      for (const name of ['src-a.mp4', 'src-c.mp4', 'src-cuts.mp4']) {
        const file = path.join(ROOT, 'fixtures', name);
        const p = await probe(file);
        const id = newId<SourceId>();
        let last = 0;
        const r = await conform(id, file, SETTINGS, path.join(DIR, 'conform'), (f) => { last = f; });
        const src: SourceClip = { id, name, path: file, sourceHash: sourceHash(file), probe: p, chapters: [], marks: [], conformId: r.record.id, motionSignature: null };
        doc.resources.sources.push(src);
        doc.resources.conforms.push(r.record);
        ids[name] = id;
        lines.push(`${name}: ${p.codec} ${p.width}x${p.height} → ${r.record.frames} frames, moshable ${r.record.moshable}, audio ${r.record.audio ? r.record.audio.sampleRate : 'none'}, progress reached ${(last * 100).toFixed(0)}%`);
      }
      const ok = doc.resources.conforms.every((c) => c.moshable && c.proxy);
      return { pass: ok, evidence: lines.join('; ') };
    });

    // 2. Scene detection → chapters (§1b).
    await step('S2', 'Detect cuts into chapters', async () => {
      const src = doc.resources.sources.find((s) => s.id === ids['src-cuts.mp4'])!;
      const conf = doc.resources.conforms.find((c) => c.id === src.conformId)!;
      const cuts = await detectCuts(conf, 0.5);
      src.chapters = chaptersFromCuts(cuts, conf.frames, 0.5);
      return { pass: cuts.map((c) => c.frame).join() === '90,180', evidence: `cuts at ${cuts.map((c) => c.frame).join(', ')}; chapters ${src.chapters.map((c) => `[${c.start},${c.end})`).join(' ')}` };
    });

    // 3. Slice: marks persisted on the source (they were a session Map in EDENA), blocks from marks and a chapter.
    await step('S3', 'Slice marks and a chapter into picture/motion blocks with effects', async () => {
      const A = doc.resources.sources.find((s) => s.id === ids['src-a.mp4'])!;
      const C = doc.resources.sources.find((s) => s.id === ids['src-c.mp4'])!;
      const X = doc.resources.sources.find((s) => s.id === ids['src-cuts.mp4'])!;
      A.marks.push({ id: newId<MarkId>(), in: 0, out: 120, label: 'opening' }, { id: newId<MarkId>(), in: 130, out: 220, label: 'bloom' });
      C.marks.push({ id: newId<MarkId>(), in: 10, out: 130, label: 'life' });
      const ch = X.chapters[1];
      const lfo = doc.modulators.lfos[1];
      const p1 = withChain(newBlock('picture', A.id, A.marks[0].in, A.marks[0].out), [{ kind: 'fx.plane-desync', params: { dx: 40, noise: 0.4 } }, { kind: 'fx.feedback', params: { decay: 0.75, rotate: 0.5 } }]);
      p1.graph.nodes[1].bindings.amount = { lfo: { lfoId: lfo.id, depth: 1, op: 'multiply' } };
      const m1 = withChain(newBlock('motion', C.id, C.marks[0].in, C.marks[0].out), [{ kind: 'fx.plane-desync', params: { channel: 'b', dx: -30 } }]);
      const p2 = withChain(newBlock('picture', X.id, ch.start, ch.end), [{ kind: 'mosh.reorder', params: { mode: 'pingpong', from: 2, to: 28 } }]);
      const m2 = withChain(newBlock('motion', A.id, A.marks[1].in, A.marks[1].out, { repeat: 2 }), [{ kind: 'fx.feedback', params: { decay: 0.9, zoom: 1.02 } }]);
      doc.timeline.blocks = [p1, m1, p2, m2];
      const c = compileProject(doc);
      const r = { frames: c.plan.frames, ranges: c.plan.moshRanges, holds: Array.from(c.plan.held).reduce((x, y) => x + y, 0) };
      c.close();
      return { pass: r.frames === 120 + 120 + 90 + 180 && r.ranges.length >= 2, evidence: `4 blocks, ${r.frames} frames; mosh ranges ${JSON.stringify(r.ranges)}; ${r.holds} held slots` };
    });

    const c0 = compileProject(doc);
    const e = new Engine(engineOptions(doc, c0, { cacheDir: path.join(DIR, 'cache'), role: 'export' }));
    const N = e.hashes.length;
    let GT!: Float64Array;

    // 4. Render: the mosh and the effects are really there.
    await step('S4', 'Mosh + GPU effects render, deterministically', async () => {
      await e.renderRange(0, N - 1, { hash: true });
      GT = e.hashes.slice();
      const plain = structuredClone(doc);
      for (const b of plain.timeline.blocks) b.graph = { nodes: b.graph.nodes.filter((n) => n.kind === 'source.clip' || n.kind === 'output.sink'), edges: [] };
      for (const b of plain.timeline.blocks) b.graph.edges = [{ id: newId(), from: { node: b.graph.nodes[0].id, port: 'out' as never }, to: { node: b.graph.nodes[1].id, port: 'in' as never } }];
      const cp = compileProject(plain);
      const ep = new Engine(engineOptions(plain, cp, { cacheDir: path.join(DIR, 'cache'), role: 'export' }));
      await ep.renderRange(0, N - 1, { hash: true });
      let differ = 0;
      for (let t = 0; t < N; t++) if (ep.hashes[t] !== GT[t]) differ++;
      ep.dispose(); cp.close();
      return { pass: differ > N * 0.8, evidence: `effects change ${differ}/${N} frames vs the same timeline with empty graphs (the rest are where the effects are dialled to nothing by the LFO)` };
    });

    // 5. Freeze the motion block; the project stores the record, the cache the pixels (L25).
    await step('S5', 'Freeze a block', async () => {
      const span = c0.plan.blocks[1];
      const f = await e.freeze(span.blockId, span.start, span.end - 1);
      doc.freezes.push({ id: newId<FreezeId>(), target: { kind: 'block', blockId: span.blockId }, range: [span.start, span.end - 1], key: f.key, codec: 'raw-rgba8', fingerprint: e.fingerprint, createdAt: new Date().toISOString() });
      const s0 = { ...e.stats };
      await e.renderRange(span.start, span.end - 1, { hash: true });
      const frozen = e.stats.frozenFrames - s0.frozenFrames, decodes = e.stats.decoded - s0.decoded;
      let eq = true;
      for (let t = span.start; t < span.end; t++) if (e.hashes[t] !== GT[t]) eq = false;
      return { pass: frozen === span.end - span.start && decodes === 0 && eq, evidence: `froze [${span.start},${span.end}) (key ${f.key.slice(0, 12)}…); re-render read ${frozen} frozen frames, ${decodes} decodes, equal to live: ${eq}` };
    });

    // 6. Cold seeks into every block, in a scrambled order.
    await step('S6', 'Cold seeks land on the linear frames', async () => {
      const fresh = new Engine(engineOptions(doc, c0, { cacheDir: path.join(DIR, 'cache'), role: 'export' }));
      const frames = [505, 3, 250, 130, 419, 333, 180, 509, 0];
      for (const t of frames) await fresh.renderRange(t, t, { hash: true });
      let code = '';
      try { await fresh.renderRange(N, N); } catch (err) { code = (err as MoshpitError).code; }
      const bad = frames.filter((t) => fresh.hashes[t] !== GT[t]);
      fresh.dispose();
      return { pass: bad.length === 0 && code === 'RANGE_INVALID', evidence: `${frames.length} cold single-frame seeks (${frames.join(', ')}), mismatches: ${bad.length ? bad.join(',') : 'none'}; a seek past the end raises ${code}` };
    });

    // 7. Export: MP4 with audio, twice; HAP; an independent decode check (Moshpit 2.0's decode-count check).
    let mp4 = '';
    await step('S7', 'Export MP4 with per-clip audio, byte-identical twice; HAP export', async () => {
      const shas: string[] = [];
      const ffprobe = findFfmpeg().ffprobe;
      for (const k of [1, 2]) {
        const ex = new Engine(engineOptions(doc, c0, { cacheDir: path.join(DIR, 'cache'), role: 'export' }));
        const rep = await exportRange(ex, doc, c0.plan, { format: 'mp4-h264', width: 640, height: 360, audio: true }, path.join(DIR, `slice-${k}.mp4`), { tmpDir: path.join(DIR, 'tmp') });
        ex.dispose();
        shas.push(crypto.createHash('sha256').update(fs.readFileSync(rep.file)).digest('hex'));
        if (k === 1) { mp4 = rep.file; notes.push(`export: ${rep.frames} frames in ${(rep.ms / 1000).toFixed(1)} s (${rep.fps.toFixed(0)} fps), ${rep.audioSamples} audio samples`); }
      }
      const probeJ = JSON.parse((await run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,sample_rate,duration_ts,channels', '-of', 'json', mp4])).stdout);
      const v = probeJ.streams.find((s: { codec_type: string }) => s.codec_type === 'video'), a = probeJ.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
      const dec = await run(findFfmpeg().ffmpeg, ['-v', 'error', '-i', mp4, '-f', 'null', '-']);
      const hap = await exportRange(new Engine(engineOptions(doc, c0, { cacheDir: path.join(DIR, 'cache'), role: 'export' })), doc, c0.plan, { format: 'hap', width: 640, height: 360, audio: true, range: [100, 199] }, path.join(DIR, 'slice-hap.mov'), { tmpDir: path.join(DIR, 'tmp') });
      const hapJ = JSON.parse((await run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', hap.file])).stdout);
      const expectSamples = new AudioClock(new RationalClock(doc.settings.fps), 48000).sample(N);
      const pass = shas[0] === shas[1] && +v.nb_read_frames === N && a?.codec_name === 'aac' && dec.stderr.trim() === '' && hapJ.streams[0].codec_name === 'hap' && +hapJ.streams[0].nb_read_frames === 100 && +a?.duration_ts === expectSamples;
      return { pass, evidence: `MP4 twice: sha256 ${shas[0] === shas[1] ? 'equal' : 'DIFFER'} (${shas[0].slice(0, 12)}…); ffprobe decodes ${v.nb_read_frames}/${N} video frames with no errors, audio ${a?.codec_name} ${a?.sample_rate} Hz ${a?.channels} ch, ${a?.duration_ts} samples against ${expectSamples} on the timeline's clock (L28); HAP export: ${hapJ.streams[0].codec_name}, ${hapJ.streams[0].nb_read_frames}/100 frames` };
    });

    // 8. Persistence: save → load → recompile → render equals what was rendered before saving.
    await step('S8', 'Save, load, recompile, re-render identically', async () => {
      const file = path.join(DIR, 'slice.moshpit.json');
      saveProjectFile(file, doc);
      const { doc: back, warnings } = loadProjectFile(file);
      const c1 = compileProject(back);
      const e2 = new Engine(engineOptions(back, c1, { cacheDir: path.join(DIR, 'cache-reload'), role: 'export' }));
      await e2.renderRange(0, N - 1, { hash: true });
      let bad = 0;
      for (let t = 0; t < N; t++) if (e2.hashes[t] !== GT[t]) bad++;
      const keyAgain = e2.freezeKeyFor(back.freezes[0].target.blockId, back.freezes[0].range[0], back.freezes[0].range[1]);
      e2.dispose(); c1.close();
      return { pass: bad === 0 && warnings.length === 0 && keyAgain === back.freezes[0].key, evidence: `${fs.statSync(file).size} B project; reloaded render: ${bad}/${N} frames differ; the stored freeze key recomputes identically after reload: ${keyAgain === back.freezes[0].key}` };
    });
    e.dispose(); c0.close();
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('stopped at'))) throw err;
  }
  return { tests, notes };
}
