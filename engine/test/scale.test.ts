// R2 / D2: the scale benchmark, run with the unit tests so an O(n²) mistake shows up as a red
// test, not at minute 39 of a composition. Targets from the plan: a 40-minute timeline, ~2,000
// clips, 10k markers, 1,000 nodes / 2,000 edges, 10k bindings. Thresholds are generous ceilings,
// not goals; every run retains its measured numbers in E artifacts/bench/scale.json.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileStage1, dirtyFrames, type ClipInput } from '../src/timeline/stage1';
import { compileBlockGraph } from '../src/graph/stage2';
import { openSamples } from '../src/bitstream/mp4';
import { newBlock, newEdge, newNode, newProject } from '../src/project/build';
import { parseProject, serializeProject } from '../src/project/io';
import { freezeKey } from '../src/runtime/freeze';
import type { Block, BlockGraph, ChapterId, LfoId, MarkId, ProjectDoc, SourceClip, SourceId } from '../src/model';
import { conformed, ARTIFACTS } from './helpers';

const results: Record<string, number> = {};
const time = <T>(name: string, fn: () => T): T => { const t = performance.now(); const r = fn(); results[name] = +(performance.now() - t).toFixed(1); return r; };
const clips = new Map<SourceId, ClipInput>();
const ids: SourceId[] = [];

beforeAll(async () => {
  for (const name of ['src-a.mp4', 'src-b.mp4', 'src-c.mp4', 'src-cuts.mp4']) {
    const { record, video } = await conformed(name);
    clips.set(record.sourceId, { record, video, reader: openSamples(video) });
    ids.push(record.sourceId);
  }
});
afterAll(() => {
  for (const c of clips.values()) c.reader.close();
  fs.mkdirSync(path.join(ARTIFACTS, 'bench'), { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS, 'bench', 'scale.json'), JSON.stringify({ at: new Date().toISOString(), ms: results }, null, 2));
});

/** A 40-minute, 30 fps timeline: 72,000 frames of alternating picture and motion blocks over four clips. */
function fortyMinutes(): Block[] {
  const blocks: Block[] = [];
  let t = 0, i = 0;
  while (t < 72_000) {
    const src = ids[i % ids.length], len = clips.get(src)!.video.samples.length;
    const kind = i % 4 === 0 ? 'picture' : 'motion';
    const a = kind === 'picture' ? 0 : 5 + (i % 50), b = Math.min(len, a + 150);
    const n = Math.min(b - a, 72_000 - t);
    blocks.push(newBlock(kind, src, a, a + n));
    t += n; i++;
  }
  return blocks;
}

describe('scale (R2)', () => {
  it('compiles a 40-minute timeline (72,000 frames) through stage 1', () => {
    const blocks = fortyMinutes();
    const p = time('stage1.compile.40min', () => compileStage1({ blocks, clips, fps: { num: 30, den: 1 } }));
    expect(p.frames).toBe(72_000);
    results['stage1.blocks'] = blocks.length;
    results['stage1.samples'] = p.samples.length;
    expect(results['stage1.compile.40min']).toBeLessThan(5_000);
    // An edit near the start: the dirty-range diff over the whole timeline stays cheap.
    const edited = blocks.slice(); edited[1] = { ...edited[1], in: edited[1].in + 1, out: edited[1].out + 1 };
    const q = compileStage1({ blocks: edited, clips, fps: { num: 30, den: 1 } });
    const d = time('stage1.dirty.40min', () => dirtyFrames(p, q));
    expect(d.reduce((x, y) => x + y, 0)).toBeLessThan(1000); // bounded by the next picture block
    expect(results['stage1.dirty.40min']).toBeLessThan(200);
    // A freeze key over a whole block's worth of frame keys.
    time('freeze.key.10k', () => freezeKey({ stage1: p, span: p.blocks[0], plan: compileBlockGraph(p.blocks[0].blockId, blocks[0].graph), graph: 'g', range: [0, 9_999], seed: 1, bpm: 120, fingerprint: 'f', format: 'x' }));
    expect(results['freeze.key.10k']).toBeLessThan(100);
  });

  it('compiles a 1,000-node / 2,000-edge graph through stage 2', () => {
    // A chain of Mix nodes, each fed by the previous Mix and by a Plane desync side branch on both
    // its B and mask inputs (a VideoFrame read as a luma mask): 4 edges per pair, 1,997 in all.
    const src = newNode('source.clip'), out = newNode('output.sink');
    const nodes = [src];
    const edges = [];
    let prev = src;
    for (let i = 0; i < 499; i++) {
      const side = newNode('fx.plane-desync', { x: i, y: 1 }), mix = newNode('route.mix', { x: i, y: 0 });
      nodes.push(side, mix);
      edges.push(newEdge(prev.id, side.id), newEdge(prev.id, mix.id, 'out', 'a'), newEdge(side.id, mix.id, 'out', 'b'), newEdge(side.id, mix.id, 'out', 'mask'));
      prev = mix;
    }
    nodes.push(out);
    edges.push(newEdge(prev.id, out.id));
    const g: BlockGraph = { nodes, edges };
    results['stage2.nodes'] = nodes.length; results['stage2.edges'] = edges.length;
    const p = time('stage2.compile.1000', () => compileBlockGraph('b' as never, g));
    expect(p.ok).toBe(true);
    expect(nodes.length).toBe(1_000);
    expect(edges.length).toBe(1_997);
    expect(p.steps.filter((x) => x.lumaInputs[2]).length).toBe(499);
    expect(p.slotCount).toBeLessThanOrEqual(4); // slot reuse holds at size
    expect(results['stage2.compile.1000']).toBeLessThan(1_000);
  });

  it('saves and loads a project with 2,000 clips, 10,000 markers and 10,000 bindings', () => {
    const doc: ProjectDoc = newProject('big');
    const lfo = doc.modulators.lfos[0].id as LfoId;
    for (let i = 0; i < 2_000; i++) {
      const s: SourceClip = { id: `s${i}` as SourceId, name: `clip-${i}.mp4`, path: `D:\\media\\clip-${i}.mp4`, sourceHash: 'h'.repeat(64), probe: { codec: 'h264', width: 1920, height: 1080, fps: { num: 30, den: 1 }, durationSec: 60, pixFmt: 'yuv420p', hasAlpha: false },
        chapters: [{ id: `c${i}` as ChapterId, start: 0, end: 900, autoDetected: true }], marks: Array.from({ length: 5 }, (_, k) => ({ id: `m${i}-${k}` as MarkId, in: k * 100, out: k * 100 + 50 })), motionSignature: null };
      doc.resources.sources.push(s);
    }
    for (let i = 0; i < 1_000; i++) {
      const b = newBlock(i % 4 ? 'motion' : 'picture', `s${i}` as SourceId, 10, 160);
      for (let k = 0; k < 10; k++) { const n = newNode('fx.plane-desync'); n.bindings.dx = { lfo: { lfoId: lfo, depth: 0.5, op: 'add' } }; b.graph.nodes.push(n); }
      doc.timeline.blocks.push(b);
    }
    const text = time('project.serialize', () => serializeProject(doc));
    results['project.bytes'] = text.length;
    const back = time('project.parse', () => parseProject(text));
    expect(back.doc.resources.sources.length).toBe(2_000);
    expect(back.doc.timeline.blocks.reduce((n, b) => n + Object.keys(b.graph.nodes.flatMap((x) => Object.keys(x.bindings))).length, 0)).toBe(10_000);
    expect(results['project.serialize'] + results['project.parse']).toBeLessThan(3_000);
  });
});
