// L17 colour fixtures, run on the real GPU: ramps, bars and identity passes through the working
// pipeline (8-bit display-encoded → linear RGBA16F → 8-bit). The plan asks for these "immediately":
// a pipeline that loses a level here loses it on every frame of every export.

import { GL2Backend, COLOUR_SHADERS } from '../../engine/src/gpu/backend';
import { createGpuNode } from '../../engine/src/gpu/nodes';
import { DEF_BY_KIND } from '../../engine/src/nodes/defs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { TestResult } from './gate';

const W = 256, H = 64;

function fixture(): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, band = y >> 4;
    // rows 0-15 grey ramp, 16-31 red ramp, 32-47 green ramp, 48-63 eight colour bars
    if (band === 0) px.set([x, x, x, 255], i);
    else if (band === 1) px.set([x, 255 - x, (x * 7) & 255, 255], i);
    else if (band === 2) px.set([(x * 13) & 255, x, 255 - x, 255], i);
    else { const b = x >> 5; px.set([b & 1 ? 255 : 16, b & 2 ? 235 : 16, b & 4 ? 191 : 16, 255], i); }
  }
  return px;
}

export async function runColour(): Promise<{ tests: TestResult[]; notes: string[] }> {
  const be = new GL2Backend({ bytes: 256 << 20 });
  const src8 = be.target(W, H, 'rgba8', 'in'), lin = be.target(W, H, 'rgba16f', 'lin'), lin2 = be.target(W, H, 'rgba16f', 'lin2'), out8 = be.target(W, H, 'rgba8', 'out');
  const ingress = be.program('colour.ingress', COLOUR_SHADERS.ingress, 1), egress = be.program('colour.egress', COLOUR_SHADERS.egress, 1);
  const input = fixture(), got = new Uint8Array(input.length), u = new Float32Array(16);
  const roundTrip = (through: (a: typeof lin, b: typeof lin2) => typeof lin) => {
    be.uploadRGBA8(src8, input);
    be.draw(ingress, lin, null, src8);
    be.draw(egress, out8, null, through(lin, lin2));
    be.readRGBA8(out8, got);
    let max = 0, off = 0;
    for (let i = 0; i < got.length; i++) { const d = Math.abs(got[i] - input[i]); if (d) off++; if (d > max) max = d; }
    return { max, off };
  };
  const tests: TestResult[] = [];
  const t = (id: string, name: string, r: { max: number; off: number }) => tests.push({ id, name, pass: r.max === 0, evidence: `${W}×${H} ramps + bars: max diff ${r.max}/255, ${r.off} bytes changed` });

  t('K1', 'Every 8-bit level survives ingress → linear RGBA16F → egress', roundTrip((a) => a));
  const pd = createGpuNode(DEF_BY_KIND.get('fx.plane-desync')!, false, be, W, H);
  u.fill(0); u[14] = 1 / W; u[15] = 1 / H; // amount 0, grain 0
  t('K2', 'Plane desync at amount 0 is bit-exact identity', roundTrip((a, b) => { pd.render([a], b, u); return b; }));
  const mix = createGpuNode(DEF_BY_KIND.get('route.mix')!, false, be, W, H);
  t('K3', 'Mix at 0 returns A exactly (CONSTANT_ONE mask unwired)', roundTrip((a, b) => { u[0] = 0; mix.render([a, null, null], b, u); return b; }));
  const fb = createGpuNode(DEF_BY_KIND.get('fx.feedback')!, false, be, W, H);
  t('K4', 'Feedback trail\'s first frame after reset passes through exactly (declared initial state)', roundTrip((a, b) => { fb.reset(); u[0] = 0.9; u[1] = 1; fb.render([a], b, u); return b; }));
  // §6 contract: spill a live trail to disk, dispose the node, restore into a fresh one — the next frame is identical.
  {
    const file = path.join(os.tmpdir(), `moshpit-spill-${process.pid}.f32`);
    const a = createGpuNode(DEF_BY_KIND.get('fx.feedback')!, false, be, W, H), b = createGpuNode(DEF_BY_KIND.get('fx.feedback')!, false, be, W, H);
    const o1 = be.target(W, H, 'rgba16f', 'o1'), o2 = be.target(W, H, 'rgba16f', 'o2');
    u.fill(0); u[0] = 0.8; u[1] = 0.97; u[2] = 2; u[14] = 1 / W; u[15] = 1 / H;
    be.uploadRGBA8(src8, input); be.draw(ingress, lin, null, src8);
    a.reset(); for (let k = 0; k < 5; k++) a.render([lin], o1, u);
    a.spillToDisk(file); a.dispose();
    b.reset(); b.restoreFromDisk(file);
    // The reference: a third node replayed the same way, never interrupted.
    const c = createGpuNode(DEF_BY_KIND.get('fx.feedback')!, false, be, W, H);
    c.reset(); for (let k = 0; k < 5; k++) c.render([lin], o1, u);
    c.render([lin], o1, u); b.render([lin], o2, u);
    const x = new Uint8Array(W * H * 4), y = new Uint8Array(W * H * 4);
    be.draw(egress, out8, null, o1); be.readRGBA8(out8, x);
    be.draw(egress, out8, null, o2); be.readRGBA8(out8, y);
    let d = 0; for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - y[i]));
    tests.push({ id: 'K6', name: 'spillToDisk → dispose → restoreFromDisk resumes a feedback trail exactly (§6)', pass: d === 0 && fs.statSync(file).size === W * H * 16, evidence: `state file ${fs.statSync(file).size} B; next frame after restore vs uninterrupted: max diff ${d}/255` });
    fs.rmSync(file); b.dispose(); c.dispose(); be.release(o1); be.release(o2);
  }
  pd.dispose(); mix.dispose(); fb.dispose();
  const leak = be.liveBytes - (src8.bytes + lin.bytes + lin2.bytes + out8.bytes);
  tests.push({ id: 'K5', name: 'dispose() returns every node texture to the budget (§6 contract)', pass: leak === 0, evidence: `${leak} bytes still accounted after disposing three nodes` });
  be.dispose();
  return { tests, notes: [`GPU: ${be.gpuName}`] };
}
