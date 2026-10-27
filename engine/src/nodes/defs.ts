// The node definitions M1 ships: three representative GPU nodes that prove the contract (one
// stateless, one temporal, one bitstream), plus the source, routing and sink infrastructure the
// compiler needs. Pure data (L19): the GPU implementations live in gpu/nodes.ts and register
// against these kinds; the UI library, tooltips and the CT page builder read only this file.
//
// Ports from Moshpit 1 `src/ops.ts` (cfd5d8c): planeDesyncSpatial (help text and ranges), the
// feedback family; the spike's fb shader; the spike's PROXY for keyframe removal.

import type { NodeDef, ParamDef, PortDef } from '@moshpit/core';
import { kind, pkey, port } from '@moshpit/core';
import { STATELESS_OPS } from './ops/stateless';
import { TEMPORAL_OPS } from './ops/temporal';
import { BITSTREAM_DEFS } from './ops/bitstream';

const P = (key: string, label: string, type: ParamDef['type'], dflt: ParamDef['default'], help: string, extra: Partial<ParamDef> = {}): ParamDef =>
  ({ key: pkey(key), label, type, default: dflt, help, modulatable: type === 'float', ...extra });
const IN = (key: string, label: string, type: PortDef['type'], cardinality: PortDef['cardinality'] = 'required-one', extra: Partial<PortDef> = {}): PortDef =>
  ({ key: port(key), label, type, cardinality, ...extra });
const OUT = (key: string, label: string, type: PortDef['type'], extra: Partial<PortDef> = {}): PortDef => ({ key: port(key), label, type, ...extra });

const STATELESS = { mode: 'stateless', lookBehind: 0, lookAhead: 0, seekPolicy: 'none', initialState: 'none', boundary: 'reset' } as const;
const PURE = { deterministic: true } as const;

export const SOURCE_CLIP: NodeDef = {
  kind: kind('source.clip'), defVersion: 1, label: 'Clip', blurb: 'The block\'s clip as an encoded stream: the input every mosh starts from.',
  category: 'Source', domain: 'ENCODED_STREAM', inputs: [], outputs: [OUT('out', 'Stream', 'EncodedVideoStream')],
  params: [], temporal: { ...STATELESS, mode: 'segment', seekPolicy: 'decode-from-segment-start', initialState: 'the GOP containing the frame' },
  impl: { preview: 'EXACT', export: 'EXACT' }, determinism: PURE, resources: { workingTextures: 0, stateFrames: 0 },
  failure: { codes: ['MEDIA_FILE_MISSING', 'DECODE_FAILED'], onUnavailable: 'pass-through' }, freezable: false,
};

/** The decode boundary (§1f). The planner inserts it; it is never placed by hand. */
export const DECODE: NodeDef = {
  kind: kind('decode.webcodecs'), defVersion: 1, label: 'Decode', blurb: 'The one decode boundary between the encoded stream and the GPU graph.',
  category: 'Routing', domain: 'ENCODED_STREAM', inputs: [IN('in', 'Stream', 'EncodedVideoStream')], outputs: [OUT('out', 'Frame', 'VideoFrame')],
  params: [], temporal: { ...STATELESS, mode: 'segment', seekPolicy: 'decode-from-segment-start', initialState: 'decoder reset at a keyframe' },
  impl: { preview: 'EXACT', export: 'EXACT' }, determinism: { deterministic: false, reason: 'byte-identical only on the pinned software decoder (L30); hardware decode is preview-only' },
  resources: { workingTextures: 1, stateFrames: 0 }, failure: { codes: ['DECODE_FAILED', 'DECODE_FRAMES_WITHHELD'], onUnavailable: 'pass-through' }, freezable: false,
};

/**
 * The seam mosh (§1f): a timeline-scope node, one per block seam. EXACT is the real bitstream
 * edit in stage 1. PROXY is the spike's GPU imitation over a clean decode — hold the last
 * picture at every hold point (F1), then accumulate the clean stream's frame-to-frame residual.
 */
export const SEAM_MOSH: NodeDef = {
  kind: kind('seam.mosh'), defVersion: 1, shaderVersion: 2, label: 'Seam mosh', family: 'Bitstream',
  blurb: 'Where one block bleeds into the next: the motion of the incoming clip smears over the picture already on screen.',
  category: 'Mosh', domain: 'ENCODED_STREAM', inputs: [IN('in', 'Stream', 'EncodedVideoStream')], outputs: [OUT('out', 'Stream', 'EncodedVideoStream')],
  params: [P('keepInnerKeyframes', 'Heal at GOPs', 'bool', false, 'Off: the smear runs to the next picture block. On: the incoming clip\'s own keyframes reset the picture every GOP.', { modulatable: false })],
  temporal: { mode: 'segment', lookBehind: 0, lookAhead: 0, seekPolicy: 'decode-from-segment-start', initialState: 'whatever picture is on screen at the seam', boundary: 'reset' },
  impl: { preview: 'PROXY', export: 'EXACT' }, determinism: PURE, resources: { workingTextures: 3, stateFrames: 1 },
  failure: { codes: ['BITSTREAM_SPLICE_INCOMPATIBLE', 'DECODE_FRAMES_WITHHELD'], onUnavailable: 'pass-through' }, freezable: true,
};

/** An in-block encoded op (B1: in-block only). Moshpit 1's Reverse / Ping-pong / Stride, on P-frames inside one GOP. */
export const MOSH_REORDER: NodeDef = {
  kind: kind('mosh.reorder'), defVersion: 1, label: 'Reorder', family: 'Bitstream',
  blurb: 'Play a window of P-frames reversed, ping-ponged or strided: the motion runs backwards over the current picture.',
  category: 'Mosh', domain: 'ENCODED_STREAM', inputs: [IN('in', 'Stream', 'EncodedVideoStream')], outputs: [OUT('out', 'Stream', 'EncodedVideoStream')],
  params: [
    P('mode', 'Mode', 'enum', 'reverse', 'Reverse plays the window backwards; ping-pong plays it forward then back; stride plays the even frames, then the odd.', { options: ['reverse', 'pingpong', 'stride'], onNode: true }),
    P('from', 'From', 'int', 0, 'First frame of the window, counted from the block\'s in-point.', { min: 0, max: 100000, step: 1, onNode: true, modulatable: false }),
    P('to', 'To', 'int', 30, 'Frame after the window. The window stays inside one GOP: a keyframe at its start stays put, and it stops at the next keyframe.', { min: 1, max: 100000, step: 1, onNode: true, modulatable: false }),
  ],
  temporal: { mode: 'segment', lookBehind: 0, lookAhead: 0, seekPolicy: 'decode-from-segment-start', initialState: 'none', boundary: 'reset' },
  impl: { preview: 'PROXY', export: 'EXACT' }, determinism: PURE, resources: { workingTextures: 0, stateFrames: 0 },
  failure: { codes: ['BITSTREAM_REORDER_CROSSES_KEYFRAME'], onUnavailable: 'pass-through' }, freezable: false,
};

/** Representative stateless node: Moshpit 1 `planeDesyncSpatial`, as a shader. */
export const PLANE_DESYNC: NodeDef = {
  kind: kind('fx.plane-desync'), defVersion: 1, shaderVersion: 2, label: 'Plane desync', family: 'Plane',
  blurb: 'Shift one colour channel sideways, off-register from the other two.',
  category: 'Effect', domain: 'GPU_FRAME', inputs: [IN('in', 'Frame', 'VideoFrame')], outputs: [OUT('out', 'Frame', 'VideoFrame')],
  params: [
    P('channel', 'Channel', 'enum', 'r', 'Which channel shifts.', { options: ['r', 'g', 'b'], onNode: true, ctOrder: 4 }),
    P('dx', 'Shift X', 'float', 24, 'Horizontal shift at full effect, in pixels of a 1080p frame so a recipe looks the same at any size. Clamped to the edge, not wrapped.', { min: -200, max: 200, unit: 'px', onNode: true, ctOrder: 1 }),
    P('dy', 'Shift Y', 'float', 0, 'Vertical shift at full effect, in pixels of a 1080p frame.', { min: -200, max: 200, unit: 'px', onNode: true, ctOrder: 2 }),
    P('amount', 'Amount', 'float', 1, 'How much of the shift applies. Drive it with an LFO to make the channel breathe.', { min: 0, max: 1, ctOrder: 3 }),
    P('noise', 'Grain', 'float', 0, 'Seeded per-frame grain on the shifted channel. Deterministic: the same frame always gets the same grain.', { min: 0, max: 1, ctOrder: 5 }),
  ],
  temporal: STATELESS, impl: { preview: 'EXACT', export: 'EXACT' }, determinism: PURE,
  resources: { workingTextures: 1, stateFrames: 0 }, failure: { codes: [], onUnavailable: 'pass-through' }, freezable: true,
};

/** Representative temporal node: recursive feedback (the spike's fb shader; Moshpit 1's feedback family). */
export const FEEDBACK: NodeDef = {
  kind: kind('fx.feedback'), defVersion: 1, shaderVersion: 1, label: 'Feedback loop', family: 'Feedback',
  blurb: 'Blend each frame over a zoomed, turned copy of the last output: trails that grow and drift.',
  category: 'Effect', domain: 'GPU_FRAME', inputs: [IN('in', 'Frame', 'VideoFrame')], outputs: [OUT('out', 'Frame', 'VideoFrame')],
  params: [
    P('decay', 'Trail', 'float', 0.82, 'How much of the last output survives each frame. 0 is off; near 1 the trail never fades.', { min: 0, max: 0.99, onNode: true, ctOrder: 1 }),
    P('zoom', 'Zoom', 'float', 0.985, 'Scale of the fed-back copy. Below 1 the trail rushes outwards; above 1 it falls inwards.', { min: 0.9, max: 1.1, onNode: true, ctOrder: 2 }),
    P('rotate', 'Turn', 'float', 0, 'Degrees the fed-back copy turns each frame.', { min: -10, max: 10, unit: '°', onNode: true, ctOrder: 3 }),
  ],
  temporal: { mode: 'past-dependent', lookBehind: 1, lookAhead: 0, seekPolicy: 'checkpoint+replay', initialState: 'the trail is empty: the first frame of the block passes through', boundary: 'carry-optional' },
  impl: { preview: 'EXACT', export: 'EXACT' }, determinism: PURE,
  resources: { workingTextures: 2, stateFrames: 1 }, failure: { codes: ['GPU_VRAM_EXCEEDED'], onUnavailable: 'pass-through' }, freezable: true,
};

/** L5 multi-input with declared disconnected semantics: an unwired mask reads as all-ones. */
export const MIX: NodeDef = {
  kind: kind('route.mix'), defVersion: 1, shaderVersion: 2, label: 'Mix', blurb: 'Blend two frames by a mode (mix, add, screen, difference, multiply), optionally through a mask.',
  category: 'Routing', domain: 'GPU_FRAME',
  inputs: [IN('a', 'A', 'VideoFrame'), IN('b', 'B', 'VideoFrame'), IN('mask', 'Mask', 'Field', 'optional-one', { subtype: 'Mask', disconnected: 'CONSTANT_ONE' })],
  outputs: [OUT('out', 'Frame', 'VideoFrame')],
  params: [
    P('mix', 'Mix', 'float', 0.5, 'Share of B in the result. With a mask, the mask scales it per pixel.', { min: 0, max: 1, onNode: true, ctOrder: 1 }),
    // Phase 1.4: blend modes. 'mix' is the cross-fade Mix always was (same pixels); the others
    // combine A and B first, then Mix fades from A to that.
    P('mode', 'Mode', 'enum', 'mix', 'How B combines with A: mix (cross-fade), add, screen, difference or multiply.', { options: ['mix', 'add', 'screen', 'difference', 'multiply'], onNode: true }),
  ],
  temporal: STATELESS, impl: { preview: 'EXACT', export: 'EXACT' }, determinism: PURE,
  resources: { workingTextures: 1, stateFrames: 0 }, failure: { codes: [], onUnavailable: 'pass-through' }, freezable: true,
};

// Phase 1.4, utility nodes: pass-throughs that tidy and name the wiring, and a Switch.
const PASS: Pick<NodeDef, 'temporal' | 'impl' | 'determinism' | 'resources' | 'failure' | 'freezable'> = { temporal: STATELESS, impl: { preview: 'EXACT', export: 'EXACT' }, determinism: PURE, resources: { workingTextures: 0, stateFrames: 0 }, failure: { codes: [], onUnavailable: 'pass-through' }, freezable: false };
export const REROUTE: NodeDef = {
  kind: kind('route.reroute'), defVersion: 1, shaderVersion: 1, label: 'Reroute', blurb: 'Tidies a picture wire: passes it on unchanged (double-click a wire to add one).',
  category: 'Routing', domain: 'GPU_FRAME', inputs: [IN('in', 'Frame', 'VideoFrame')], outputs: [OUT('out', 'Frame', 'VideoFrame')], params: [], ...PASS,
};
export const REROUTE_STREAM: NodeDef = {
  kind: kind('route.reroute-stream'), defVersion: 1, label: 'Reroute (stream)', blurb: 'Tidies an encoded wire before the Decode: passes the stream on unchanged.',
  category: 'Routing', domain: 'ENCODED_STREAM', inputs: [IN('in', 'Stream', 'EncodedVideoStream')], outputs: [OUT('out', 'Stream', 'EncodedVideoStream')], params: [], ...PASS,
};
export const NULL_NODE: NodeDef = {
  kind: kind('route.null'), defVersion: 1, shaderVersion: 1, label: 'Null', blurb: 'A named checkpoint: wire downstream from it, then add nodes before it without rewiring what follows.',
  category: 'Routing', domain: 'GPU_FRAME', inputs: [IN('in', 'Frame', 'VideoFrame')], outputs: [OUT('out', 'Frame', 'VideoFrame')], params: [], ...PASS,
};
export const SWITCH: NodeDef = {
  kind: kind('route.switch'), defVersion: 1, shaderVersion: 1, label: 'Switch', blurb: 'Picks one of up to four pictures. Animate Input (an LFO, a Value) to hot-swap branches.',
  category: 'Routing', domain: 'GPU_FRAME',
  inputs: [IN('a', 'A', 'VideoFrame'), IN('b', 'B', 'VideoFrame', 'optional-one', { disconnected: 'PASS_THROUGH' }), IN('c', 'C', 'VideoFrame', 'optional-one', { disconnected: 'PASS_THROUGH' }), IN('d', 'D', 'VideoFrame', 'optional-one', { disconnected: 'PASS_THROUGH' })],
  outputs: [OUT('out', 'Frame', 'VideoFrame')],
  params: [P('select', 'Input', 'float', 0, 'Which input passes: 0 = A … 3 = D (rounded). An unwired input shows A.', { min: 0, max: 3, step: 1, onNode: true, ctOrder: 1 })],
  temporal: STATELESS, impl: { preview: 'EXACT', export: 'EXACT' }, determinism: PURE,
  resources: { workingTextures: 0, stateFrames: 0 }, failure: { codes: [], onUnavailable: 'pass-through' }, freezable: true,
};

/** L10: the only legal cycle break. Reads strictly the n−1 buffer; black at the block's first frame. */
export const DELAY: NodeDef = {
  kind: kind('route.delay'), defVersion: 1, shaderVersion: 1, label: 'Delay', blurb: 'Last frame\'s input. The only way to wire a loop.',
  category: 'Routing', domain: 'GPU_FRAME', inputs: [IN('in', 'Frame', 'VideoFrame')], outputs: [OUT('out', 'Frame', 'VideoFrame')], params: [],
  temporal: { mode: 'past-dependent', lookBehind: 1, lookAhead: 0, seekPolicy: 'checkpoint+replay', initialState: 'transparent black at the block\'s first frame', boundary: 'carry-optional' },
  impl: { preview: 'EXACT', export: 'EXACT' }, determinism: PURE, resources: { workingTextures: 1, stateFrames: 1 },
  failure: { codes: [], onUnavailable: 'pass-through' }, freezable: false,
};

export const OUTPUT: NodeDef = {
  kind: kind('output.sink'), defVersion: 1, label: 'Output', blurb: 'What this block hands to the timeline: preview, export and freeze all read here.',
  category: 'Output', domain: 'GPU_FRAME', inputs: [IN('in', 'Frame', 'VideoFrame')], outputs: [], params: [],
  temporal: STATELESS, impl: { preview: 'EXACT', export: 'EXACT' }, determinism: PURE,
  resources: { workingTextures: 0, stateFrames: 0 }, failure: { codes: ['EXPORT_FAILED'], onUnavailable: 'pass-through' }, freezable: false,
};

// ── 3.2 Phase 3: containers (graph/container.ts) ──
// Their ports are the instance's own (body.ports), so the defs declare none. They never reach Stage 2
// or the runtime: inlineContainers replaces them with the inner nodes before anything compiles.
export const GROUP_IN: NodeDef = {
  kind: kind('group.in'), defVersion: 1, label: 'Group input', blurb: "Inside a container: its outputs are the container's inputs.",
  category: 'Routing', domain: 'GPU_FRAME', inputs: [], outputs: [], params: [], ...PASS,
};
export const GROUP_OUT: NodeDef = {
  kind: kind('group.out'), defVersion: 1, label: 'Group output', blurb: "Inside a container: its inputs are the container's outputs.",
  category: 'Routing', domain: 'GPU_FRAME', inputs: [], outputs: [], params: [], ...PASS,
};
export const CONTAINER: NodeDef = {
  kind: kind('group.container'), defVersion: 1, label: 'Container', blurb: 'A look you can open: several nodes wired together, with a few knobs on its face.',
  category: 'Routing', domain: 'GPU_FRAME', inputs: [], outputs: [], params: [], ...PASS,
};

/** Infrastructure + the three contract nodes, then Moshpit 1's 31 ops (nodes/ops; plane desync is shared). */
export const NODE_DEFS: readonly NodeDef[] = [
  SOURCE_CLIP, DECODE, SEAM_MOSH, MOSH_REORDER, PLANE_DESYNC, FEEDBACK, MIX, DELAY, OUTPUT, REROUTE, REROUTE_STREAM, NULL_NODE, SWITCH,
  GROUP_IN, GROUP_OUT, CONTAINER,
  ...STATELESS_OPS.map((o) => o.def), ...TEMPORAL_OPS.map((o) => o.def), ...BITSTREAM_DEFS,
];
export const DEF_BY_KIND = new Map(NODE_DEFS.map((d) => [d.kind as string, d]));
/**
 * Kinds a user can place from the library. The decode boundary and the seam are placed by the
 * planner and the timeline; every block is built with exactly one Source and one Output, so those
 * are never placed (a second Source runs as pass-through, a missing Output breaks the graph: E-1).
 */
// Phase 1.1: Decode is placeable (the visible boundary); Seam, Source and Output are not. 3.2: the
// container kinds are placed by stamping a look or collapsing a selection, never from the library.
export const isPlaceable = (d: Pick<NodeDef, 'kind'>) => ![SEAM_MOSH.kind, SOURCE_CLIP.kind, OUTPUT.kind, GROUP_IN.kind, GROUP_OUT.kind, CONTAINER.kind].includes(d.kind as never);
export const PLACEABLE = NODE_DEFS.filter(isPlaceable);
