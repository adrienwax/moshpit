// Real Engine constructors and checkpoint disk operations; only GPU textures are
// in-memory doubles. These tests establish ownership/isolation, not native GPU parity.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Engine, type EngineOptions } from '../src/runtime/engine';

type Texture = { pixels: Float32Array };
vi.mock('../src/gpu/backend', async original => ({
  ...await original<typeof import('../src/gpu/backend')>(),
  GL2Backend: class {
    gpuName = 'checkpoint-test';
    target(w: number, h: number): Texture { return { pixels: new Float32Array(w * h * 4) }; }
    program() { return {}; }
    blit(from: Texture, to: Texture) { to.pixels.set(from.pixels); }
    readFloat(from: Texture, out: Float32Array) { out.set(from.pixels); }
    uploadFloat(to: Texture, input: Float32Array) { to.pixels.set(input); }
    dispose() {}
  },
}));

const dirs: string[] = [], engines: Engine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mosh-spill-')); dirs.push(dir); return dir; }
function make(cacheDir: string, w: number, h: number, value: number, spillBytes?: number) {
  const engine = new Engine({
    cacheDir, spillBytes, checkpointTextures: 2,
    plan: { frames: 100, width: w, height: h, fps: { num: 60, den: 1 }, blocks: [], samples: [], moshRanges: [] } as unknown as EngineOptions['plan'],
    blocks: [], blockPlans: new Map(), lfos: [], seed: 1, bpm: 120,
  });
  engines.push(engine);
  const e = engine as any; // Inspect private checkpoint state while exercising its actual methods.
  const texture = { pixels: new Float32Array(w * h * 4).fill(value) };
  const runtime = { blockId: 'block', state: [texture], nodes: [{ resumed: vi.fn() }] };
  const spill = (t: number) => { texture.pixels.fill(value); e.saveCp(t, runtime); e.evictCp(); return e.cps.get(t); };
  const restore = (cp: unknown) => { texture.pixels.fill(-1); e.restoreCp(cp, runtime); expect([...texture.pixels]).toEqual(Array(w * h * 4).fill(value)); };
  return { engine, e, spill, restore };
}

describe('checkpoint ownership across engines sharing a cache root', () => {
  it('restores different-sized states at the same frame without overwriting or deleting another engine', () => {
    const dir = directory();
    const master = make(dir, 2, 2, 0.25), proxy = make(dir, 1, 1, 0.75);
    const a = master.spill(30), b = proxy.spill(30);
    expect(a.spilled).not.toBe(b.spilled);
    expect(path.dirname(a.spilled)).toBe(path.join(dir, 'checkpoints'));
    expect(path.dirname(b.spilled)).toBe(path.join(dir, 'checkpoints'));
    expect(fs.statSync(a.spilled).size).toBe(2 * 2 * 4 * 4);
    expect(fs.statSync(b.spilled).size).toBe(1 * 1 * 4 * 4);
    master.restore(a); proxy.restore(b);
    master.e.dropCp(a);
    expect(fs.existsSync(a.spilled)).toBe(false); expect(fs.existsSync(b.spilled)).toBe(true);
    proxy.restore(b);
    const replacement = master.spill(30);
    master.engine.dispose();
    expect(fs.existsSync(replacement.spilled)).toBe(false);
    expect(fs.existsSync(b.spilled)).toBe(true); proxy.restore(b);
  });

  it('keeps ownership when dimensions match and one engine trims its disk budget', () => {
    const dir = directory();
    const left = make(dir, 1, 1, 0.125, 16), right = make(dir, 1, 1, 0.875, 16);
    const a = left.spill(30), b = right.spill(30);
    const next = left.spill(60); // A second 16-byte state exceeds this engine's private cap.
    expect(left.e.stats.spillDrops).toBe(1);
    expect(fs.existsSync(a.spilled)).toBe(false);
    expect(fs.existsSync(b.spilled)).toBe(true);
    left.restore(next); right.restore(b);
    right.engine.dispose();
    expect(fs.existsSync(next.spilled)).toBe(true); left.restore(next);
  });
});
