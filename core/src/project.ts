// L12–L14: one project document, sectioned and independently versioned. Only the project scope
// lives here (L13): user/app config and the disposable cache are elsewhere, and undo history is
// a separate journal.
//
// Forward compatibility (C4): every object in this document may carry fields this build does not
// know. Load keeps them, save writes them back, and no code path rebuilds an object by picking
// known fields. `Extra` marks the objects where that matters most.

import type { Rational, AudioDescriptor, ChannelLayout } from './media';
import type {
  BlockId, ChapterId, ComponentId, ConformId, EdgeId, ElementId, FreezeId, LfoId, MarkId, ValueId, NodeId, NodeKind, ParamKey,
  PortKey, ProjectId, SourceId,
} from './ids';

/** Unknown fields written by a newer build. Preserved verbatim, never edited (C4). */
export type Extra = { [unknownField: string]: unknown };

/** L12: one version integer per section, so a layout tweak never forces a graph migration. */
export interface SectionVersions {
  project: number;
  graph: number;
  nodeDefs: number;
  components: number;
  resources: number;
}

// graph 2 (3.2 Phase 3): a block graph may hold container nodes. A file is written at graph 2 only
// when it holds one, so a project without containers still opens cleanly in 3.1.
export const CURRENT_VERSIONS: SectionVersions = { project: 1, graph: 2, nodeDefs: 1, components: 1, resources: 1 };

export interface ProjectDoc extends Extra {
  format: 'moshpit.project';
  versions: SectionVersions;
  id: ProjectId;
  name: string;
  createdAt: string;
  settings: ProjectSettings;
  resources: ResourceManifest;
  timeline: Timeline;
  /** L8: modulators live at project scope so their phase is continuous across blocks. */
  modulators: { lfos: Lfo[]; values?: ProjectValue[] } & Extra;
  /** L25: freeze records only. The pixels live in the disposable cache. */
  freezes: FreezeRecord[];
  exportConfig: ExportConfig;
  /** D3: per-block view state (pan/zoom/selection/viewer), restored on block switch. */
  view: { perBlock: Record<string, BlockViewState>; activeBlock?: BlockId } & Extra;
  /** 3.2 Phase 3: the container library. Placing a look stamps a copy of one of these (D1). */
  components?: { looks: ComponentDef[] } & Extra;
}

export interface ProjectSettings extends Extra {
  /** L9: the one authoritative frame rate. Every clip conforms to it. */
  fps: Rational;
  /** Working size: what clips conform to, so the mosh texture lives at this size. Canonical 1920×1080. */
  working: { w: number; h: number };
  /** L23: BPM is a single project constant for 3.0 (D4). */
  bpm: number;
  /** L11: the project seed. Every seeded value derives from it. */
  seed: number;
  timeDisplay: 'musical' | 'seconds';
  colour: { workingSpace: 'linear-rec709'; intermediate: 'rgba16f' };
}

export interface ResourceManifest extends Extra {
  sources: SourceClip[];
  conforms: ConformedSource[];
}

/** A file on disk the project uses. Never edited (rule 5: sources are untouched). */
export interface SourceClip extends Extra {
  id: SourceId;
  name: string;
  path: string;
  /** Content hash of the original file (sha256 over size + sampled blocks). Relink matches on it. */
  sourceHash: string;
  probe: SourceProbe;
  /** §1b: stored regions, advisory navigation metadata. */
  chapters: Chapter[];
  /** EDENA slice marks, persisted (they were a session Map before). */
  marks: SliceMark[];
  /** The conform currently pinned for this clip (D7). */
  conformId?: ConformId;
  /** §1c: reserved. Always null in 3.0, so populating it later is additive, not a migration. */
  motionSignature?: null;
  /** The slice of the file this source is (Use with IN/OUT): its conform starts at `startSec`. Absent = the whole file. */
  range?: SourceRange;
}

/** A time range of a source file, in seconds of the file itself. */
export interface SourceRange {
  startSec: number;
  durSec: number;
}

export interface SourceProbe {
  codec: string;
  width: number;
  height: number;
  /** As probed (`r_frame_rate`). May be variable; the conform makes it constant. */
  fps: Rational;
  durationSec: number;
  frames?: number;
  pixFmt: string;
  hasAlpha: boolean;
  transfer?: string;
  rotation?: number;
  audio?: AudioDescriptor & { codec: string };
}

export interface Chapter extends Extra {
  id: ChapterId;
  /** Frame range on the conformed clip, [start, end). Fixed numbers, not seconds. */
  start: number;
  end: number;
  label?: string;
  autoDetected: boolean;
  threshold?: number;
}

export interface SliceMark extends Extra {
  id: MarkId;
  in: number;
  out: number;
  label?: string;
}

/**
 * L29: conform is a first-class, versioned, hashed artifact. Reopening re-conforms and compares
 * `conformedHash`; a mismatch keeps this pinned record and raises CONFORM_CHANGED (D7).
 */
/**
 * Conform quality: the speed ↔ smoothness trade-off picked at import. Every option writes the same
 * mosh-compatible stream (Main, no B-frames, closed GOP 120, 1 ref, BT.709) with byte-identical
 * SPS/PPS, so clips conformed at different qualities share one timeline. Only the x264 search
 * effort differs: slower finds cleaner motion vectors, which is what a mosh smears.
 * Times: a 2-min 1080p clip, master encode, i7-7700K (BUILD-LOG, 7 Oct).
 */
export type ConformQuality = 'smooth' | 'balanced' | 'fast';
export const CONFORM_QUALITIES: readonly { id: ConformQuality; label: string; x264: string; hint: string }[] = [
  { id: 'smooth', label: 'Smooth', x264: 'medium', hint: 'Cleanest pixels and smear. About 1.5× realtime at 1080p' },
  { id: 'balanced', label: 'Balanced', x264: 'veryfast', hint: 'Near-Smooth quality at twice the speed. About 3× realtime at 1080p' },
  { id: 'fast', label: 'Fast', x264: 'superfast', hint: 'Quickest import, files about a third larger. About 4.4× realtime at 1080p' },
];
export const DEFAULT_CONFORM_QUALITY: ConformQuality = 'balanced';

export interface ConformedSource extends Extra {
  id: ConformId;
  sourceId: SourceId;
  sourceHash: string;
  /** Conformed from this slice of the file only (SourceClip.range). Absent = the whole file. */
  range?: SourceRange;
  /** Bump when the conform recipe changes output. */
  conformVersion: number;
  /** The quality it was conformed at. Absent on records from before presets existed. */
  quality?: ConformQuality;
  /**
   * Proxy-first import: 'proxy' while only the proxy exists (browse, slice and mosh preview work;
   * EXACT preview, freeze and export wait for the master). 'ready' or absent: both exist.
   */
  status?: 'proxy' | 'ready';
  /** The exact ffmpeg arguments, recorded so a reviewer can rerun them. */
  args: string[];
  ffmpegVersion: string;
  path: string;
  codecString: string;
  profile: 'main';
  pocType: 2;
  refs: 1;
  gop: number;
  fps: Rational;
  width: number;
  height: number;
  frames: number;
  /** Indices of the IDR frames. Fixed GOP, so derivable, but recorded for the proxy check. */
  keyframes: number[];
  frameNumBits: number;
  /** sha256 of the conformed video bitstream (samples only, not container metadata). */
  conformedHash: string;
  /** Keyframe-locked low-res proxy (decision 2): same frame count and IDR positions, smaller. */
  proxy?: { path: string; width: number; height: number; conformedHash: string };
  /** L27: the clip's own audio, kept through conform. */
  audio?: { sampleRate: number; channels: number; layout: ChannelLayout; codec: string; samples: number };
  /** False for the decode-only fallback (L29): usable in effect graphs, not in encoded-domain nodes. */
  moshable: boolean;
  /** Warnings raised while conforming (HDR tonemapped, alpha dropped). Error codes only. */
  notes: string[];
  createdAt: string;
}

export interface Timeline extends Extra {
  /** Picture/motion blocks in order. The timeline is the master sequencer (C2). */
  blocks: Block[];
}

/**
 * Moshpit 1's invariant, carried over: a `picture` block starts with a real keyframe (a hard
 * cut); a `motion` block never includes a keyframe, so its P-frames smear over whatever is on
 * screen. That *is* the mosh, and it lives at the seam (§1f), not in either block's graph.
 */
export type BlockKind = 'picture' | 'motion';

export interface Block extends Extra {
  id: BlockId;
  kind: BlockKind;
  sourceId: SourceId;
  /** Frame range on the conformed clip, [in, out). */
  in: number;
  out: number;
  /** Moshpit 1 semantics: repeat replays the range. On a motion block that is the bloom. */
  repeat: number;
  /** §1f: how this block joins the one before it. Stage 1 owns it. */
  seam: SeamMosh;
  /** The block's own node graph (C2), run after the decode boundary on this block's span. */
  graph: BlockGraph;
  /** L27: per-clip audio. Base audio plays straight; `mirror` scales this block's audio-mirror sends (0–1, default 1). */
  audio: { mute: boolean; mirror?: number };
  /** D3: secondary source references used by this block's graph, shown as a "refs" badge. */
  refs: SourceId[];
  label?: string;
  colour?: string;
}

/**
 * §1f: the seam is a declared node kind living at timeline scope. For a motion block it removes
 * the keyframes inside the block (they would reset the picture); a picture block's seam is a
 * plain cut. `keepInnerKeyframes` lets a motion block "heal" at its own GOP boundaries.
 */
export interface SeamMosh extends Extra {
  kind: 'seam.mosh';
  defVersion: number;
  keepInnerKeyframes: boolean;
}

export interface BlockGraph extends Extra {
  nodes: NodeInstance[];
  edges: GraphEdge[];
}

/** L6: a value at a parameter key. Arrays carry element identities so bindings never shift. */
export type ParamValue = number | boolean | string | { items: { id: ElementId; value: number | boolean | string }[] };

export interface NodeInstance extends Extra {
  id: NodeId;
  kind: NodeKind;
  /** The definition version this instance was authored against (L31). Older than current = Legacy (D6). */
  defVersion: number;
  params: Record<string, ParamValue>;
  /** L7: value sources layered over the base value, per parameter. */
  bindings: Record<string, ParamBinding>;
  position: { x: number; y: number };
  label?: string;
  /** Audit S1: opt in to carrying state across the block boundary. Enters the freeze key. */
  carryState?: boolean;
  /** L5: explicit stable order for `many` inputs. Project state, not wire-creation order. */
  inputOrder?: Record<string, EdgeId[]>;
  bypass?: boolean;
  /** 3.2 Phase 3: a `group.container` node's own sub-graph (an owned copy, D1). */
  body?: ContainerBody;
}

// ── 3.2 Phase 3: containers ──
// A container is one node that owns a sub-graph. Its graph holds exactly one `group.in` (whose
// outputs are the container's inputs) and one `group.out` (whose inputs are its outputs): the
// explicit In / Out ports. One level only: a container's graph holds no container. It compiles by
// inlining into the block's flat graph before anything else sees it (engine/src/graph/container.ts).

/** A port on a container's boundary, typed with the real edge types. */
export interface PortSpec extends Extra {
  key: PortKey;
  label: string;
  type: import('./media').EdgeType;
}

/** An authored knob on a container's face: its value (the container's own param) drives one inner param. */
export interface Macro extends Extra {
  key: ParamKey;
  label: string;
  help: string;
  /** The macro's own range; the container's param of this key holds its value. */
  min: number;
  max: number;
  default: number;
  target: { node: NodeId; param: ParamKey };
  /** Macro value → inner value: the Values Map-Range. Absent = the value as is. */
  map?: Pick<ValueLink, 'from' | 'to' | 'curve'>;
}

export interface ContainerBody extends Extra {
  graph: BlockGraph;
  ports: { in: PortSpec[]; out: PortSpec[] };
  macros: Macro[];
  /** The library entry this copy was stamped from, and its revision then ("Update master"). */
  origin?: { component: ComponentId; rev: number };
}

/** A library entry: a named look a container is stamped from. */
export interface ComponentDef extends Extra {
  id: ComponentId;
  name: string;
  rev: number;
  body: ContainerBody;
  /** Saved positions of the exposed knobs; absent in older looks. Authored defaults stay in body.macros. */
  params?: Record<string, ParamValue>;
  /** Browser filing (Phase 2's looks) and one sentence of what it does. */
  look?: string;
  does?: string;
}

export interface GraphEdge extends Extra {
  id: EdgeId;
  from: { node: NodeId; port: PortKey };
  to: { node: NodeId; port: PortKey };
}

/**
 * L7 trimmed by audit S6: base → LFO → expression. Automation, hardware and audio-mirror layers
 * are reserved names; a hardware control (the CT) writes the *base* as an undoable edit, which
 * keeps L11 true (an unsaved knob position would otherwise change a render).
 */
export type ComposeOp = 'replace' | 'add' | 'multiply';
export interface ParamBinding extends Extra {
  lfo?: { lfoId: LfoId; depth: number; op: ComposeOp };
  expression?: { source: string; op: ComposeOp };
  /** Phase 1.5: driven by a project Value through a Map-Range (the param's base; an LFO still swings around it). */
  value?: ValueLink;
}

/**
 * Phase 1.5, Value: one named project knob (0..1) that drives any number of params, e.g. GLITCH
 * INTENSITY on three effects. Like the LFOs, it lives at project scope and reaches params through
 * bindings, drawn as ghost wires; it is not a wire in the graph.
 */
export interface ProjectValue extends Extra {
  id: ValueId;
  label: string;
  /** 0..1 */
  value: number;
}

/** Math, Map-Range: the Value's 0..1 goes through a curve, then onto [from, to] in the param's own units. */
export const VALUE_CURVES = ['linear', 'ease-in', 'ease-out', 'smooth'] as const;
export interface ValueLink {
  valueId: ValueId;
  from: number;
  to: number;
  curve: (typeof VALUE_CURVES)[number];
}

/** The param a Value sets through its link (the engine and the UI's readout use this one function). */
export function mapValue(v: number, link: Pick<ValueLink, 'from' | 'to' | 'curve'>): number {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  const c = link.curve === 'ease-in' ? x * x : link.curve === 'ease-out' ? 1 - (1 - x) * (1 - x) : link.curve === 'smooth' ? x * x * (3 - 2 * x) : x;
  return link.from + (link.to - link.from) * c;
}

/** Moshpit 1's global LFO, extended to musical time (L23). Phase is a pure function of the timeline frame. */
export const LFO_SHAPES = ['sine', 'triangle', 'ramp', 'square'] as const;
export interface Lfo extends Extra {
  id: LfoId;
  label: string;
  shape: (typeof LFO_SHAPES)[number];
  /** Cycle length. In beats when `unit` is 'beats' (default), seconds otherwise. */
  period: number;
  unit: 'beats' | 'seconds';
  /** 0..1 of one cycle at timeline frame 0. */
  phase: number;
}

export type FreezeTarget =
  | { kind: 'node'; blockId: BlockId; nodeId: NodeId }
  | { kind: 'block'; blockId: BlockId };

/** L25: the project stores the record and key, never the pixels. */
export interface FreezeRecord extends Extra {
  id: FreezeId;
  target: FreezeTarget;
  /** Timeline frames, inclusive. */
  range: [number, number];
  key: string;
  /** Decision 4 (audit F4): raw first. */
  codec: 'raw-rgba8';
  fingerprint: string;
  createdAt: string;
}

export interface ExportConfig extends Extra {
  format: 'mp4-h264' | 'prores-422hq' | 'prores-4444' | 'hap' | 'hapq' | 'hap-alpha' | 'png-seq';
  width: number;
  height: number;
  /** Timeline frames, inclusive. Absent = whole timeline. */
  range?: [number, number];
  audio: boolean;
  /** M5: run the audio-mirror sends over the clip audio (default on; the sends themselves default dry). */
  audioMirror?: boolean;
  outDir?: string;
}

export interface BlockViewState extends Extra {
  pan: { x: number; y: number };
  zoom: number;
  selected: NodeId[];
  viewer?: NodeId;
}
