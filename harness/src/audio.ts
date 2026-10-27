// M5 checkpoints A and B as a round trip through the real export: clips with known tones in, an MP4
// out, its audio decoded back and analysed span by span (Goertzel). Proves per-clip audio survives
// the pipeline, lands on the frame clock's samples, and follows each L27 rule.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcRenderer } from 'electron';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { compileProject, engineOptions } from '../../engine/src/runtime/session';
import { Engine } from '../../engine/src/runtime/engine';
import { exportRange } from '../../engine/src/runtime/export';
import { findFfmpeg } from '../../engine/src/conform/ffmpeg';
import { AudioClock, RationalClock } from '../../engine/src/time/clock';
import { MoshpitError } from '../../engine/src/errors';
import type { ProjectDoc } from '@moshpit/core';
import { OUT, withSources } from './fixtures';
import type { TestResult } from './gate';

const log = (m: string) => ipcRenderer.send('log', m);
const RATE = 48000;

/** Power of frequency f in pcm[from, from+n), Goertzel. */
function power(pcm: Float32Array, from: number, n: number, f: number): number {
  const k = 2 * Math.cos((2 * Math.PI * f) / RATE);
  let s1 = 0, s2 = 0;
  for (let i = from; i < from + n; i++) { const s = pcm[i] + k * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n);
}
const rms = (pcm: Float32Array, from: number, n: number) => { let s = 0; for (let i = from; i < from + n; i++) s += pcm[i] * pcm[i]; return Math.sqrt(s / n); };

/** Decode an export's audio to mono float at 48 kHz. */
function decode(file: string): Float32Array {
  const r = spawnSync(findFfmpeg().ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

export async function audioProject(): Promise<{ doc: ProjectDoc; spans: { label: string; start: number; end: number; expect: number | 'silence' }[] }> {
  const doc = newProject('audio', { working: { w: 640, h: 360 } });
  const [A, B] = await withSources(doc, ['src-a.mp4', 'src-b.mp4']); // A: 440 Hz stereo, B: 660 Hz mono
  doc.timeline.blocks = [
    newBlock('picture', A, 0, 60),                                                        //   0– 60 straight A
    newBlock('motion', B, 100, 160),                                                      //  60–120 B, held slot at B's keyframe 120
    newBlock('motion', A, 10, 40, { repeat: 2 }),                                         // 120–180 A twice (loop by repeat)
    newBlock('picture', B, 0, 30, { audio: { mute: true } }),                             // 180–210 muted
    withChain(newBlock('motion', B, 30, 60), [{ kind: 'mosh.hold', params: { at: 50, span: 10, times: 4 } }]), // 210–270 stretched, pitch kept
    withChain(newBlock('motion', B, 160, 190), [{ kind: 'mosh.speed', params: { rate: 50 } }]),               // 270–330 half speed → 330 Hz
  ];
  const spans = [
    { label: 'straight', start: 0, end: 60, expect: 440 as const },
    { label: 'held slot inside', start: 60, end: 120, expect: 660 as const },
    { label: 'repeat 1', start: 120, end: 150, expect: 440 as const },
    { label: 'repeat 2', start: 150, end: 180, expect: 440 as const },
    { label: 'mute', start: 180, end: 210, expect: 'silence' as const },
    { label: 'hold op (stretch)', start: 210, end: 270, expect: 660 as const },
    { label: 'speed 50% (resample)', start: 270, end: 330, expect: 330 as const },
  ];
  return { doc, spans };
}

export async function runAudio(): Promise<{ tests: TestResult[]; notes: string[] }> {
  const tests: TestResult[] = [];
  const dir = path.join(OUT, 'audio');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const check = async (id: string, name: string, fn: () => Promise<{ pass: boolean; evidence: string }>) => {
    try { tests.push({ id, name, ...(await fn()) }); } catch (e) { tests.push({ id, name, pass: false, evidence: `threw: ${e instanceof MoshpitError ? JSON.stringify(e.toJSON()) : (e as Error)?.stack ?? e}` }); }
    const r = tests[tests.length - 1];
    log(`[audio] ${r.pass ? 'PASS' : 'FAIL'} ${id} ${r.evidence.slice(0, 260)}`);
  };
  const { doc, spans } = await audioProject();
  const exportOnce = async (name: string, mirror: boolean) => {
    const c = compileProject(doc);
    const e = new Engine(engineOptions(doc, c, { cacheDir: path.join(dir, 'cache'), role: 'export' }));
    try { return await exportRange(e, doc, c.plan, { format: 'mp4-h264', width: 640, height: 360, audio: true, audioMirror: mirror }, path.join(dir, name), { tmpDir: path.join(dir, 'tmp') }); }
    finally { e.dispose(); c.close(); }
  };
  const clock = new AudioClock(new RationalClock(doc.settings.fps), RATE);

  await check('A1', 'Exports keep per-clip audio on the frame clock, following every L27 rule', async () => {
    const rep = await exportOnce('dry.mp4', false);
    const pcm = decode(rep.file);
    const N = clock.sample(rep.frames);
    const rows = spans.map((s) => {
      const a = clock.sample(s.start) + 480, n = clock.sample(s.end) - clock.sample(s.start) - 960; // 10 ms clear of each edge
      const p = { 440: power(pcm, a, n, 440), 660: power(pcm, a, n, 660), 330: power(pcm, a, n, 330), 220: power(pcm, a, n, 220) };
      const top = Object.entries(p).sort((x, y) => y[1] - x[1])[0];
      const loud = rms(pcm, a, n);
      const got = loud < 1e-4 ? 'silence' : Number(top[0]);
      return { ...s, got, ok: got === s.expect };
    });
    const pass = Math.abs(pcm.length - N) <= 1024 && rows.every((r) => r.ok);
    return { pass, evidence: `${pcm.length} decoded samples vs ${N} on the clock (AAC frame tolerance 1024); ${rows.map((r) => `${r.label}: ${r.got}${r.ok ? '' : ` (expected ${r.expect})`}`).join('; ')}` };
  });
  await check('B1', 'Audio mirror: gated spans change, the lane-free span does not, the change starts at the seam', async () => {
    const dry = decode(path.join(dir, 'dry.mp4'));
    const rep = await exportOnce('mirror.mp4', true);
    const wet = decode(rep.file);
    const diff = (a: number, n: number) => { let d = 0; for (let i = a; i < a + n; i++) d += Math.abs(wet[i] - dry[i]); return d / n; };
    const s60 = clock.sample(60);
    const control = diff(0, s60 - 1024); // block 1: a plain picture block, no mapped family
    const gated = diff(s60 + 1024, clock.sample(120) - s60 - 2048); // block 2: a motion block → the gate send
    // Onset: the first 64-sample window after which the difference stays large, near the seam.
    let onset = -1;
    for (let i = s60 - 4096; i < s60 + 4096; i += 64) if (diff(i, 64) > 0.02) { onset = i; break; }
    const pass = control < 0.002 && gated > 0.02 && Math.abs(onset - (s60 - 480)) <= 1024;
    return { pass, evidence: `mean |wet − dry|: lane-free block ${control.toFixed(5)}, gated motion block ${gated.toFixed(4)}; the difference starts at sample ${onset}, seam at ${s60} with a 480-sample ramp (AAC tolerance 1,024)` };
  });

  await check('B2', 'Mirrored export is byte-identical twice (L30)', async () => {
    const a = fs.readFileSync(path.join(dir, 'mirror.mp4'));
    const rep = await exportOnce('mirror2.mp4', true);
    return { pass: a.equals(fs.readFileSync(rep.file)), evidence: `${a.length} B, ${a.equals(fs.readFileSync(rep.file)) ? 'identical' : 'DIFFER'}` };
  });
  return { tests, notes: [] };
}
