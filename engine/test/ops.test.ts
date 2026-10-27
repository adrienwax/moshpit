// The 31 ported ops: definition contract, compile, and the bitstream family on an independent decoder.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { NODE_DEFS, DEF_BY_KIND } from '../src/nodes/defs';
import { STATELESS_OPS } from '../src/nodes/ops/stateless';
import { TEMPORAL_OPS } from '../src/nodes/ops/temporal';
import { BITSTREAM_DEFS, TRANSFORMS, applyBitstreamOp } from '../src/nodes/ops/bitstream';
import { compileBlockGraph } from '../src/graph/stage2';
import { compileStage1, sampleBytes, type ClipInput } from '../src/timeline/stage1';
import { annexBParameterSets, toAnnexB } from '../src/bitstream/h264';
import { openSamples } from '../src/bitstream/mp4';
import { findFfmpeg } from '../src/conform/ffmpeg';
import { newBlock, withChain } from '../src/project/build';
import { blockSpanFrames } from '../src/timeline/length';
import type { SourceId } from '@moshpit/core';
import { conformed } from './helpers';

const PORTED = [...STATELESS_OPS.map((o) => o.def), ...TEMPORAL_OPS.map((o) => o.def), ...BITSTREAM_DEFS, DEF_BY_KIND.get('fx.plane-desync')!];

describe('the ported op table', () => {
  it('has all 31 Moshpit 1 ops, by family', () => {
    expect(PORTED.length).toBe(31);
    const fam = (f: string) => PORTED.filter((d) => d.family === f).length;
    expect([fam('Bitstream'), fam('Plane'), fam('Feedback'), fam('Geometry'), fam('Tone'), fam('Degrade')]).toEqual([7, 6, 4, 5, 7, 2]);
    expect(new Set(NODE_DEFS.map((d) => d.kind)).size).toBe(NODE_DEFS.length);
  });

  it.each(PORTED.map((d) => [d.kind, d] as const))('%s meets the definition contract', (_k, d) => {
    expect(d.blurb.length).toBeGreaterThan(10);
    const orders = d.params.map((p) => p.ctOrder).filter((x) => x !== undefined);
    expect(new Set(orders).size).toBe(orders.length);
    expect(d.params.filter((p) => p.onNode).length).toBeLessThanOrEqual(4);
    for (const p of d.params) {
      expect(p.help.length, `${d.kind}.${p.key} help`).toBeGreaterThan(8);
      expect(p.key).not.toBe('bypass');
      if (p.type === 'float' || p.type === 'int') {
        expect(p.min).toBeLessThanOrEqual(p.max!);
        expect(Number(p.default)).toBeGreaterThanOrEqual(p.min!);
        expect(Number(p.default)).toBeLessThanOrEqual(p.max!);
      }
      if (p.type === 'enum') expect(p.options).toContain(p.default);
    }
    // Wired between a source and an output, every op compiles with no errors.
    const b = withChain(newBlock('motion', 'S' as SourceId, 1, 60), [{ kind: d.kind }]);
    const plan = compileBlockGraph(b.id, b.graph);
    expect(plan.errors.map((e) => e.code)).toEqual([]);
    if (d.domain === 'ENCODED_STREAM') expect(plan.encodedOps).toHaveLength(1);
    else expect(plan.steps.map((s) => s.def.kind)).toContain(d.kind);
  });
});

describe('bitstream transforms (Moshpit 1 apply/length)', () => {
  const w = Array.from({ length: 30 }, (_, i) => i);
  // Moshpit 1's closed-form `length` for each, at the given params: apply and length must agree.
  const cases: [string, Record<string, number>, number][] = [
    ['mosh.hold', { at: 50, span: 3, times: 5 }, 30 - 3 + 15],
    ['mosh.stride', { every: 3, offset: 1 }, 10],
    ['mosh.stride', { every: 3, offset: 1, invert: 1 }, 20],
    ['mosh.reverse', { chunk: 0 }, 30],
    ['mosh.pingpong', { laps: 2, pause: 2, doubleEnds: 0 }, (30 + 28 + 4) * 2],
    ['mosh.stride-slip', { every: 4 }, 30],
    ['mosh.speed', { rate: 50 }, 60],
    ['mosh.speed', { rate: 200 }, 15],
    ['mosh.speed-ramp', { rateIn: 100, rateOut: 50 }, 40],
  ];
  it.each(cases)('%s %o has Moshpit 1\'s length and never invents a frame', (k, p, len) => {
    const out = TRANSFORMS[k](w, p);
    expect(out.length).toBe(len);
    expect(out.every((x) => x >= 0 && x < 30)).toBe(true);
  });
  it('applies inside the window only', () => {
    const out = applyBitstreamOp('mosh.reverse', w, { winFrom: 50, winLen: 20 });
    expect(out.slice(0, 15)).toEqual(w.slice(0, 15));
    expect(out.slice(15, 21)).toEqual([20, 19, 18, 17, 16, 15]);
    expect(out.slice(21)).toEqual(w.slice(21));
  });
});

describe('bitstream ops decode on an independent decoder', () => {
  const clips = new Map<SourceId, ClipInput>();
  let A: SourceId, C: SourceId;
  beforeAll(async () => {
    for (const name of ['src-a.mp4', 'src-c.mp4']) {
      const { record, video } = await conformed(name);
      clips.set(record.sourceId, { record, video, reader: openSamples(video) });
    }
    [A, C] = [...clips.keys()];
  });
  afterAll(() => { for (const c of clips.values()) c.reader.close(); });

  it.each(BITSTREAM_DEFS.map((d) => [d.kind]))('%s in a motion block and in a picture block: every sample delivered, no complaint', (k) => {
    const blocks = [withChain(newBlock('picture', A, 0, 90), [{ kind: k }]), withChain(newBlock('motion', C, 10, 150), [{ kind: k }])];
    const encodedOps = new Map(blocks.map((b) => [b.id, compileBlockGraph(b.id, b.graph).encodedOps]));
    const plan = compileStage1({ blocks, clips, fps: { num: 30, den: 1 }, encodedOps });
    const parts = [annexBParameterSets(plan.avcC), ...plan.samples.map((_, i) => toAnnexB(sampleBytes(plan, i).slice()))];
    const r = spawnSync(findFfmpeg().ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'h264', '-i', '-', '-f', 'framemd5', '-'], { input: Buffer.concat(parts), maxBuffer: 64 << 20 });
    const frames = String(r.stdout).split('\n').filter((l) => l && !l.startsWith('#')).length;
    expect(String(r.stderr).trim()).toBe('');
    expect(frames).toBe(plan.samples.length);
  });

  // Waxy's render failure: Reorder's default window (0–30) starts on a slice's keyframe. Clamped to
  // the GOP's P-frames, the stream must still decode, sample for sample, in picture and motion blocks.
  it('Reorder at its defaults (0–30) in a picture and a motion block: every sample decodes, no complaint', () => {
    const blocks = [withChain(newBlock('picture', A, 0, 90), [{ kind: 'mosh.reorder' }]), withChain(newBlock('motion', C, 10, 150), [{ kind: 'mosh.reorder' }])];
    const encodedOps = new Map(blocks.map((b) => [b.id, compileBlockGraph(b.id, b.graph).encodedOps]));
    expect(encodedOps.get(blocks[0].id)).toEqual([{ kind: 'reorder', mode: 'reverse', from: 0, to: 30 }]);
    const plan = compileStage1({ blocks, clips, fps: { num: 30, den: 1 }, encodedOps });
    const parts = [annexBParameterSets(plan.avcC), ...plan.samples.map((_, i) => toAnnexB(sampleBytes(plan, i).slice()))];
    const r = spawnSync(findFfmpeg().ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'h264', '-i', '-', '-f', 'framemd5', '-'], { input: Buffer.concat(parts), maxBuffer: 64 << 20 });
    expect(String(r.stderr).trim()).toBe('');
    expect(String(r.stdout).split('\n').filter((l) => l && !l.startsWith('#')).length).toBe(plan.samples.length);
  });

  // F1 (UX round 2): the arrangement lays blocks out with blockSpanFrames; it must match stage1's
  // real spans, or a speed / hold / stride block draws, plays and previews at the wrong length.
  it.each([...BITSTREAM_DEFS.map((d) => [d.kind, {}] as const), ['mosh.speed', { rate: 50 }] as const, ['mosh.speed', { rate: 200 }] as const])('%s %o: the UI block length is the engine span', (k, params) => {
    const b = { ...withChain(newBlock('picture', C, 10, 150), [{ kind: k, params }]), repeat: 2 };
    const plan = compileStage1({ blocks: [b], clips, fps: { num: 30, den: 1 }, encodedOps: new Map([[b.id, compileBlockGraph(b.id, b.graph).encodedOps]]) });
    const engine = plan.blocks.filter((x) => x.blockId === b.id).reduce((n, x) => n + x.end - x.start, 0);
    expect(blockSpanFrames(b) * 2).toBe(engine);
  });
});

describe('Moshpit 1 presets, ported (scripts/port-presets.mjs)', () => {
  it('has all 157, seven per op except where Moshpit 1 had a different count', async () => {
    const { PRESETS } = await import('../src/nodes/presets');
    expect(Object.values(PRESETS).flat().length).toBe(157);
    expect(Object.keys(PRESETS).length).toBe(31);
  });
  it('every preset names only params its node has, with values its definition accepts', async () => {
    const { PRESETS } = await import('../src/nodes/presets');
    for (const [k, list] of Object.entries(PRESETS)) {
      const d = DEF_BY_KIND.get(k)!;
      expect(d, k).toBeDefined();
      for (const p of list) for (const [key, v] of Object.entries(p.params)) {
        const pd = d.params.find((x) => x.key === key);
        expect(pd, `${k} "${p.name}" ${key}`).toBeDefined();
        if (pd!.type === 'bool') expect(typeof v).toBe('boolean');
        else if (pd!.type === 'enum') expect(pd!.options).toContain(v);
        else { expect(typeof v).toBe('number'); expect(v as number).toBeGreaterThanOrEqual(pd!.min!); expect(v as number).toBeLessThanOrEqual(pd!.max!); }
      }
    }
  });
});
