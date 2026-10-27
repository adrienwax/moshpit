// Every ported op, as a real running node on the real engine (GPU + WebCodecs):
//   compiles · wet 0 is an exact identity · it changes the picture · deterministic across engines
//   · temporal ops: a cold seek lands on the linear frame (checkpoint + replay through the ring)
//   · bitstream ops: Chromium decodes the rewritten stream with nothing withheld.

import { ipcRenderer } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { STATELESS_OPS } from '../../engine/src/nodes/ops/stateless';
import { TEMPORAL_OPS } from '../../engine/src/nodes/ops/temporal';
import { BITSTREAM_DEFS } from '../../engine/src/nodes/ops/bitstream';
import { DEF_BY_KIND } from '../../engine/src/nodes/defs';
import { newBlock, newProject, withChain } from '../../engine/src/project/build';
import { compileProject, engineOptions } from '../../engine/src/runtime/session';
import { Engine } from '../../engine/src/runtime/engine';
import { MoshpitError } from '../../engine/src/errors';
import type { ParamValue, ProjectDoc } from '@moshpit/core';
import { OUT, withSources } from './fixtures';
import type { TestResult } from './gate';

const log = (m: string) => ipcRenderer.send('log', m);
const N = 90;

/** Params that make an op visibly do something where its default is neutral. */
const DEMO: Record<string, Record<string, ParamValue>> = {
  'fx.saturation': { amount: 220 }, 'fx.contrast': { amount: 180 }, 'fx.brightness': { level: 160 }, 'fx.hue-rotate': { degrees: 120 },
  'fx.transform': { rotate: 12, scale: 130, offsetX: 40 },
  'mosh.speed': { rate: 60 },
};

async function doc(): Promise<{ d: ProjectDoc; A: string; C: string }> {
  const d = newProject('effects', { working: { w: 640, h: 360 } });
  const [A, , C] = await withSources(d, ['src-a.mp4', 'src-b.mp4', 'src-c.mp4']);
  return { d, A, C };
}

export async function runEffects(): Promise<{ tests: TestResult[]; notes: string[] }> {
  const { d: base, A, C } = await doc();
  const tests: TestResult[] = [];
  const cache = path.join(OUT, 'effects-cache');
  const SHOT = 60; // inside the moshed motion block
  const shots: { label: string; px: Uint8Array }[] = [];
  let shot: Uint8Array | null = null;
  const render = async (d: ProjectDoc, frames: number[] | null = null) => {
    const c = compileProject(d);
    const e = new Engine(engineOptions(d, c, { cacheDir: cache, role: 'export' }));
    try {
      if (frames) for (const f of frames) await e.renderRange(f, f, { hash: true });
      else await e.renderRange(0, e.hashes.length - 1, { hash: true, onFrame: (px, t) => { if (t === SHOT) shot = px.slice(); } });
      return { h: e.hashes.slice(), stats: { ...e.stats }, frames: e.hashes.length };
    } finally { e.dispose(); c.close(); }
  };
  // Image ops: a picture block on A then a motion block on C, the op in both, so it also sees moshed frames.
  const timeline = (k: string, params: Record<string, ParamValue>) => {
    const d = structuredClone(base);
    d.timeline.blocks = [withChain(newBlock('picture', A as never, 0, 45), [{ kind: k, params }]), withChain(newBlock('motion', C as never, 10, 55), [{ kind: k, params }])];
    return d;
  };
  const plain = await render(timeline('fx.saturation', { amount: 100, wet: 0 }));
  shots.push({ label: 'untouched', px: shot! });

  for (const op of [...STATELESS_OPS, ...TEMPORAL_OPS, { def: DEF_BY_KIND.get('fx.plane-desync')! }]) {
    const k = op.def.kind as string, t0 = performance.now();
    const temporal = op.def.temporal.mode === 'past-dependent';
    try {
      const demo = { ...(DEMO[k] ?? {}) };
      const dry: Record<string, ParamValue> = k === 'fx.plane-desync' ? { amount: 0 } : { ...demo, wet: 0 };
      const off = await render(timeline(k, dry));
      const on = await render(timeline(k, demo));
      shots.push({ label: op.def.label, px: shot! });
      const again = await render(timeline(k, demo));
      let identity = 0, changed = 0, same = 0;
      for (let f = 0; f < N; f++) { if (off.h[f] === plain.h[f]) identity++; if (on.h[f] !== plain.h[f]) changed++; if (again.h[f] === on.h[f]) same++; }
      let seekOk = true;
      if (temporal) { const s = await render(timeline(k, demo), [80, 30, 62]); seekOk = [80, 30, 62].every((f) => s.h[f] === on.h[f]); }
      const pass = identity === N && changed >= N * 0.5 && same === N && seekOk;
      tests.push({ id: k, name: op.def.label, pass, ms: Math.round(performance.now() - t0), evidence: `wet 0 identity ${identity}/${N}; changes ${changed}/${N} frames; deterministic ${same}/${N}${temporal ? `; cold seeks into the ring equal linear: ${seekOk}` : ''}` });
    } catch (e) {
      tests.push({ id: k, name: op.def.label, pass: false, evidence: `threw: ${e instanceof MoshpitError ? JSON.stringify(e.toJSON()) : (e as Error)?.stack ?? e}` });
    }
    const r = tests[tests.length - 1];
    log(`[effects] ${r.pass ? 'PASS' : 'FAIL'} ${k} ${r.pass ? '' : r.evidence.slice(0, 300)}`);
  }

  // Bitstream ops: in the motion block; the engine raises DECODE_FRAMES_WITHHELD if Chromium drops anything.
  for (const def of BITSTREAM_DEFS) {
    const k = def.kind as string, t0 = performance.now();
    try {
      const d = structuredClone(base);
      d.timeline.blocks = [newBlock('picture', A as never, 0, 45), withChain(newBlock('motion', C as never, 10, 55), [{ kind: k, params: DEMO[k] }])];
      const a = await render(d);
      shots.push({ label: def.label, px: shot! });
      const b = await render(d);
      const ref = structuredClone(d); ref.timeline.blocks[1] = newBlock('motion', C as never, 10, 55);
      const r0 = await render(ref);
      const differs = a.frames !== r0.frames || Array.from(a.h).some((h, i) => h !== r0.h[i]);
      const same = Array.from(a.h).every((h, i) => h === b.h[i]);
      tests.push({ id: k, name: def.label, pass: same && differs, ms: Math.round(performance.now() - t0), evidence: `${a.frames} frames (block without it: ${r0.frames}); Chromium decoded every sample; changes the picture: ${differs}; deterministic: ${same}` });
    } catch (e) {
      tests.push({ id: k, name: def.label, pass: false, evidence: `threw: ${e instanceof MoshpitError ? JSON.stringify(e.toJSON()) : (e as Error)?.stack ?? e}` });
    }
    const r = tests[tests.length - 1];
    log(`[effects] ${r.pass ? 'PASS' : 'FAIL'} ${k} ${r.pass ? '' : r.evidence.slice(0, 300)}`);
  }
  // A contact sheet: one frame per op at frame 60 (inside the moshed block), for eyes, not asserts.
  const W = 640, H = 360, cols = 6, sw = 320, sh = 180, rows = Math.ceil(shots.length / cols);
  const sheet = new OffscreenCanvas(cols * sw, rows * (sh + 18));
  const g = sheet.getContext('2d')!;
  g.fillStyle = '#111'; g.fillRect(0, 0, sheet.width, sheet.height);
  const tile = new OffscreenCanvas(W, H);
  shots.forEach((sh0, i) => {
    tile.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(sh0.px), W, H), 0, 0);
    const x = (i % cols) * sw, y = Math.floor(i / cols) * (sh + 18);
    g.drawImage(tile, x, y, sw, sh);
    g.fillStyle = '#eee'; g.font = '13px sans-serif'; g.fillText(sh0.label, x + 4, y + sh + 13);
  });
  const png = path.join(OUT, 'effects-sheet.png');
  fs.writeFileSync(png, Buffer.from(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  return { tests, notes: ['contact sheet: ' + png] };
}
