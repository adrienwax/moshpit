import * as fs from 'node:fs';
import * as path from 'node:path';
import { conform, type ConformSettings } from '../../engine/src/conform/conform';
import type { Block, ConformedSource, ProjectDoc, SourceClip, SourceId } from '../../engine/src/model';
import { newBlock, newEdge, newNode, newProject, withChain } from '../../engine/src/project/build';

export const ROOT = process.cwd();
export const CACHE = path.join(ROOT, 'out', 'test-cache');
export const OUT = path.join(ROOT, 'out', 'harness');
export const SETTINGS: ConformSettings = { fps: { num: 30, den: 1 }, width: 640, height: 360, proxyDivisor: 4, crf: 18 };

/** Same cache and sidecar as engine/test/helpers.ts, so a vitest run and a harness run share conforms. */
export async function conformed(name: string): Promise<ConformedSource> {
  const side = path.join(CACHE, `${name}.record.json`);
  if (fs.existsSync(side)) {
    const record = JSON.parse(fs.readFileSync(side, 'utf8')) as ConformedSource;
    if (fs.existsSync(record.path)) return record;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const r = await conform(`src-${name}` as SourceId, path.join(ROOT, 'fixtures', name), SETTINGS, CACHE);
  fs.writeFileSync(side, JSON.stringify(r.record, null, 2));
  return r.record;
}

export async function withSources(doc: ProjectDoc, names: string[]): Promise<SourceId[]> {
  const ids: SourceId[] = [];
  for (const name of names) {
    const rec = await conformed(name);
    const src: SourceClip = { id: rec.sourceId, name, path: path.join(ROOT, 'fixtures', name), sourceHash: rec.sourceHash, probe: { codec: 'h264', width: 640, height: 360, fps: rec.fps, durationSec: rec.frames / 30, pixFmt: 'yuv420p', hasAlpha: false }, chapters: [], marks: [], conformId: rec.id, motionSignature: null };
    doc.resources.sources.push(src);
    doc.resources.conforms.push(rec);
    ids.push(src.id);
  }
  return ids;
}

/**
 * The gate timeline: five blocks over three clips, every mechanism in play.
 *   p1 picture A [0,150)     plane-desync → feedback        stateful, starts the stream
 *   m1 motion  C [20,170)    plane-desync                   seam bleed; C's keyframe 120 → a hold
 *   m2 motion  B [30,150)    feedback                       stateful inside a merged mosh segment; B's keyframe 120 → a hold
 *   p2 picture A [200,290)   reorder(reverse 5..40) → plane-desync   mid-GOP primer, encoded op
 *   m3 motion  C [5,100) ×2  mix ← delay loop               a Delay cycle, repeated (bloom)
 */
export async function gateProject(opts: { effects?: boolean } = {}): Promise<ProjectDoc> {
  const doc = newProject('gate', { working: { w: 640, h: 360 } });
  doc.settings.seed = 4242;
  const [A, B, C] = await withSources(doc, ['src-a.mp4', 'src-b.mp4', 'src-c.mp4']);
  const fx = opts.effects !== false;
  const lfo = doc.modulators.lfos[0];
  const p1 = withChain(newBlock('picture', A, 0, 150), fx ? [{ kind: 'fx.plane-desync', params: { dx: 30, noise: 0.5 } }, { kind: 'fx.feedback', params: { decay: 0.8, zoom: 0.98, rotate: 1 } }] : []);
  if (fx) p1.graph.nodes[1].bindings.dx = { lfo: { lfoId: lfo.id, depth: 0.5, op: 'add' } };
  const m1 = withChain(newBlock('motion', C, 20, 170), fx ? [{ kind: 'fx.plane-desync', params: { channel: 'b', dx: -40, noise: 0.3 } }] : []);
  const m2 = withChain(newBlock('motion', B, 30, 150), fx ? [{ kind: 'fx.feedback', params: { decay: 0.85 } }] : []);
  const p2 = withChain(newBlock('picture', A, 200, 290), fx ? [{ kind: 'mosh.reorder', params: { mode: 'reverse', from: 5, to: 40 } }, { kind: 'fx.plane-desync', params: { channel: 'g', dy: 20 } }] : []);
  let m3: Block = newBlock('motion', C, 5, 100, { repeat: 2 });
  if (fx) m3 = delayLoop(m3);
  doc.timeline.blocks = [p1, m1, m2, p2, m3];
  return doc;
}

/** src → mix.a; delay → mix.b; mix → plane-desync → delay and → output. */
function delayLoop(b: Block): Block {
  const g = withChain(b, [{ kind: 'route.mix', params: { mix: 0.6 } }, { kind: 'fx.plane-desync', params: { dx: 12, channel: 'r' } }]);
  const [src, mix, pd, out] = g.graph.nodes;
  const dl = newNode('route.delay', { x: 300, y: 150 });
  g.graph.nodes.push(dl);
  g.graph.edges = [newEdge(src.id, mix.id, 'out', 'a'), newEdge(dl.id, mix.id, 'out', 'b'), newEdge(mix.id, pd.id), newEdge(pd.id, dl.id), newEdge(pd.id, out.id)];
  return g;
}
