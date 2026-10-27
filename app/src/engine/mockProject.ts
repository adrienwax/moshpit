// The prototype's demo project, as a real ProjectDoc. Used by the mock engine and as the
// dev server's starting document. The real engine starts empty.
import type {
  Block, BlockGraph, BlockId, ConformId, EdgeId, LfoId, NodeDef, NodeId, NodeInstance, ParamValue, ProjectDoc,
  ProjectId, SourceClip, SourceId, SourceProbe,
} from '@moshpit/engine';
import { CURRENT_VERSIONS, port } from '@moshpit/engine';
import { CATALOG } from './catalog';
import type { LibraryClip, LibraryFolder } from './EngineClient';

const FPS = { num: 24, den: 1 };
let n = 0;
const id = <T extends string>(prefix: string) => `${prefix}-${(++n).toString(36).padStart(4, '0')}` as T;

const probe = (codec: string, w: number, h: number, fps: [number, number], durationSec: number, audio = true): SourceProbe => ({
  codec, width: w, height: h, fps: { num: fps[0], den: fps[1] }, durationSec, frames: Math.round((durationSec * fps[0]) / fps[1]),
  pixFmt: 'yuv420p', hasAlpha: codec.startsWith('HAP'), audio: audio ? { type: 'AudioBuffer', sampleRate: 48000, channels: 2, layout: 'stereo', codec: 'pcm_s24le' } : undefined,
});

const source = (name: string, p: SourceProbe): SourceClip => ({
  id: id<SourceId>('src'), name, path: `X:\\ExampleMedia\\footage\\${name}`, sourceHash: 'mock', probe: p, chapters: [], marks: [],
  conformId: id<ConformId>('conf'), motionSignature: null,
});

const SRC_A = source('A_run_043.mov', probe('ProRes 422', 1920, 1080, [24, 1], 192));
const SRC_B = source('B_glass_11.mp4', probe('H.264', 1920, 1080, [24000, 1001], 168));
SRC_A.marks.push({ id: id('mark') as never, in: 118, out: 402 });

export function defaults(def: NodeDef): Record<string, ParamValue> {
  return Object.fromEntries(def.params.map((p) => [p.key, p.initial ?? p.default])); // U2: a new node starts visible
}

export function instance(kindKey: string, x: number, y: number, params: Record<string, ParamValue> = {}): NodeInstance {
  const d = CATALOG.find((c) => c.kind === kindKey);
  if (!d) throw new Error(`mock: no def ${kindKey}`);
  return { id: id<NodeId>('n'), kind: d.kind, defVersion: d.defVersion, params: { ...defaults(d), ...params }, bindings: {}, position: { x, y } };
}

/** Source → chain → Output, laid out left to right. Encoded→frame wires get an implicit Decode. */
function chainGraph(chain: string[]): BlockGraph {
  const src = instance('source.clip', 0, 120);
  const nodes: NodeInstance[] = [src];
  const edges: BlockGraph['edges'] = [];
  let prev = src;
  chain.forEach((k, i) => {
    const node = instance(k, 230 + i * 220, i % 2 ? 40 : 190);
    edges.push({ id: id<EdgeId>('e'), from: { node: prev.id, port: port('out') }, to: { node: node.id, port: port('in') } });
    nodes.push(node);
    prev = node;
  });
  const out = instance('output.sink', 230 + chain.length * 220, 120);
  edges.push({ id: id<EdgeId>('e'), from: { node: prev.id, port: port('out') }, to: { node: out.id, port: port('in') } });
  nodes.push(out);
  return { nodes, edges };
}

function block(kindB: Block['kind'], src: SourceClip, inF: number, outF: number, repeat: number, chain: string[]): Block {
  return {
    id: id<BlockId>('blk'), kind: kindB, sourceId: src.id, in: inF, out: outF, repeat,
    seam: { kind: 'seam.mosh', defVersion: 1, keepInnerKeyframes: false },
    graph: chainGraph(chain), audio: { mute: false }, refs: [],
  };
}

export function demoProject(): ProjectDoc {
  const blocks = [
    block('picture', SRC_A, 118, 142, 1, []),
    block('motion', SRC_A, 143, 155, 4, ['mosh.hold', 'fx.chroma-drift']),
    block('motion', SRC_A, 156, 168, 2, ['mosh.stride']),
    block('picture', SRC_B, 402, 426, 1, []),
    block('motion', SRC_B, 427, 433, 8, ['mosh.hold', 'fx.feedback-trail', 'fx.posterize']),
    block('motion', SRC_B, 434, 446, 2, ['mosh.reverse']),
  ];
  const lfo1 = id<LfoId>('lfo');
  const lfo3 = id<LfoId>('lfo');
  // LFO 1 → Block 2 · Chroma drift · Cb shift; LFO 3 → the same node's Cr shift, so the two
  // colour-difference channels drift independently (as the def's own blurb suggests). Not Hold:
  // bitstream params are read once per block and are not modulatable, so an LFO there does nothing.
  const b2 = blocks[1].graph.nodes;
  b2[2].bindings.cb = { lfo: { lfoId: lfo1, depth: 0.5, op: 'add' } };
  b2[2].bindings.cr = { lfo: { lfoId: lfo3, depth: 0.4, op: 'add' } };
  return {
    format: 'moshpit.project',
    versions: { ...CURRENT_VERSIONS },
    id: 'proj-demo' as ProjectId,
    name: 'run_043 mosh',
    createdAt: '2026-10-06T00:00:00Z',
    settings: { fps: FPS, working: { w: 1920, h: 1080 }, bpm: 124, seed: 4242, timeDisplay: 'musical', colour: { workingSpace: 'linear-rec709', intermediate: 'rgba16f' } },
    resources: { sources: [SRC_A, SRC_B], conforms: [] },
    timeline: { blocks },
    modulators: {
      lfos: [
        { id: lfo1, label: 'LFO 1', shape: 'sine', period: 16, unit: 'beats', phase: 0 },
        { id: id<LfoId>('lfo'), label: 'LFO 2', shape: 'ramp', period: 8, unit: 'beats', phase: 0.25 },
        { id: lfo3, label: 'LFO 3', shape: 'square', period: 4, unit: 'beats', phase: 0 },
      ],
    },
    freezes: [],
    exportConfig: { format: 'hap', width: 1920, height: 1080, audio: true },
    view: { perBlock: {}, activeBlock: blocks[1].id },
  };
}

const lib = (name: string, p: SourceProbe, rating: number, tags: string[], pass: LibraryClip['pass'] = true, sourceId?: SourceId): LibraryClip => ({
  path: `X:\\ExampleMedia\\footage\\${name}`, name, probe: p, rating, tags, pass, sourceId,
});

export const LIBRARY: Record<string, LibraryClip[]> = {
  'X:\\ExampleMedia\\footage': [
    lib('street_night.mp4', probe('H.264', 3840, 2160, [30, 1], 272), 2, ['street', 'night']),
    lib('B_glass_11.mp4', SRC_B.probe, 3, ['glass', 'motion'], true, SRC_B.id),
    lib('A_run_043.mov', SRC_A.probe, 4, ['runs', 'motion'], true, SRC_A.id),
    lib('caustics_raw.mov', probe('ProRes 422', 2048, 2048, [25, 1], 130), 3, ['glass']),
    lib('wall_loop_07.hap', probe('HAP', 2304, 1152, [24, 1], 8, false), 5, ['wall', 'loop']),
    lib('portrait_k2.mov', probe('ProRes 422', 1080, 1920, [25, 1], 36), 4, []),
    lib('test_bars.mp4', probe('H.264', 1280, 720, [30000, 1001], 20), 1, ['vfr']),
    lib('deepreef_a.mov', probe('ProRes 422', 1920, 1080, [24, 1], 184), 4, ['reef']),
    lib('broken_cam.avi', probe('MJPEG-B', 1920, 1080, [30, 1], 52), 1, [], { code: 'DECODE_UNSUPPORTED_CODEC' }),
  ],
};

export const FOLDERS: LibraryFolder[] = [
  {
    path: 'X:\\ExampleMedia\\footage', name: 'footage', count: 214, children: [
      { path: 'X:\\ExampleMedia\\footage\\runs', name: 'runs', count: 48, children: [] },
      { path: 'X:\\ExampleMedia\\footage\\glass', name: 'glass', count: 31, children: [] },
      { path: 'X:\\ExampleMedia\\footage\\street', name: 'street', count: 62, children: [] },
    ],
  },
  {
    path: 'X:\\ExampleMedia\\renders', name: 'renders', count: 88, children: [
      { path: 'X:\\ExampleMedia\\renders\\out', name: 'out', count: 40, children: [] },
      { path: 'X:\\ExampleMedia\\renders\\proxies', name: 'proxies', count: 48, children: [] },
    ],
  },
  { path: 'X:\\ExampleMedia\\recipes', name: 'recipes', count: 113, children: [] },
];
