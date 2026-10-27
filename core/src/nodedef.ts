// L19: the declarative node-definition schema is the single internal effect contract. The 31
// ops, the seam mosh and the sinks are all authored through this one shape; nothing has a
// secret property. L31: definitions are versioned separately from instance identity.

import type { EdgeType, FieldSubtype } from './media';
import type { NodeKind, ParamKey, PortKey } from './ids';
import type { ErrorCode } from './errors';

/** L22: a UI/library axis only. It never reaches execution logic. */
export const NODE_CATEGORIES = ['Source', 'Mosh', 'Effect', 'Routing', 'Output', 'Audio'] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

/** Effect families (Moshpit 1's six). A sub-tag for the library and the radial pie, not a colour (audit S7). */
export const EFFECT_FAMILIES = ['Bitstream', 'Plane', 'Feedback', 'Geometry', 'Tone', 'Degrade'] as const;
export type EffectFamily = (typeof EFFECT_FAMILIES)[number];

/** L4: execution domain, orthogonal to edge type and to category. */
export const EXEC_DOMAINS = ['GPU_FRAME', 'CPU_FRAME', 'ENCODED_STREAM', 'AUDIO', 'EXTERNAL_PROCESS'] as const;
export type ExecDomain = (typeof EXEC_DOMAINS)[number];

/** L5: port cardinality. One wire per input port unless the port says `many`. */
export type Cardinality = 'required-one' | 'optional-one' | 'many';

/** L5: what an optional input reads when nothing is wired to it. */
export type DisconnectedSemantics = 'CONSTANT_ONE' | 'CONSTANT_ZERO' | 'PASS_THROUGH' | 'TRANSPARENT';

export interface PortDef {
  key: PortKey;
  label: string;
  type: EdgeType;
  /** For `Field` ports. */
  subtype?: FieldSubtype;
  /** Inputs only. Outputs always fan out. */
  cardinality?: Cardinality;
  /** Required for `optional-one` and `many` inputs. */
  disconnected?: DisconnectedSemantics;
  help?: string;
}

export type ParamType = 'float' | 'int' | 'bool' | 'enum' | 'beats';

export interface ParamDef {
  /** Immutable. Renaming the label never touches this. */
  key: ParamKey;
  label: string;
  /** Tooltip text: L26 says params get theirs free from the schema. Mandatory. */
  help: string;
  type: ParamType;
  /**
   * The neutral value: what a node that lacks this key compiles with (old saves, migrations), so it
   * never changes once shipped. A new node starts from `initial` when there is one.
   */
  default: number | boolean | string;
  /**
   * U2 (9 Oct): what a freshly added node starts with, when the neutral value would make the effect
   * invisible (Saturation 100 % is the source unchanged). Reset (right-click, "default") returns
   * here too. Saved nodes keep their stored values: existing projects, presets and freezes are
   * untouched.
   */
  initial?: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  /** For `enum`. */
  options?: readonly string[];
  unit?: string;
  /** L23: shown on the node face. At most three per definition. */
  onNode?: boolean;
  /** Audit S10: slot order on the CT's six dials, 1–6. */
  ctOrder?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Can an LFO or expression drive it (L7). Discrete params usually cannot. */
  modulatable?: boolean;
}

/**
 * L10: the stateful contract. `boundary` is audit S1: state resets at a block boundary unless
 * the instance opts into `carryState`, which then enters the freeze key.
 */
export interface TemporalDecl {
  mode: 'stateless' | 'past-dependent' | 'future-dependent' | 'segment';
  lookBehind: number;
  lookAhead: number;
  seekPolicy: 'none' | 'replay-from-reset' | 'checkpoint+replay' | 'node-seek' | 'decode-from-segment-start' | 'non-seekable';
  /** A sentence: what the state is at the first frame of an evaluation. */
  initialState: string;
  boundary: 'reset' | 'carry-optional';
}

/** L18: what each backend does with the node. */
export type ImplState = 'EXACT' | 'PROXY' | 'UNAVAILABLE';
export interface ImplDecl {
  preview: ImplState;
  export: Exclude<ImplState, 'PROXY'>;
}

/** L11: a node is deterministic, or it says why it is not. */
export type DeterminismDecl = { deterministic: true } | { deterministic: false; reason: string };

/**
 * §6 + audit S2: the GPU resource contract. The engine sums these against its VRAM budget before
 * it instantiates a plan, and every GPU node implementation must provide dispose() and
 * spillToDisk() (see gpu/node-impl.ts). Sizes are in working-frame units so the budget scales
 * with resolution, not with the definition.
 */
export interface ResourceDecl {
  /** Working-size RGBA16F textures the node holds per instance while it is live. */
  workingTextures: number;
  /** Per-frame state that checkpoints must snapshot, in working-frame units (0 for stateless). */
  stateFrames: number;
}

export interface NodeDef {
  kind: NodeKind;
  /** L31: bump when the node's output for the same params changes meaning. */
  defVersion: number;
  /** L31: bump when the shader text changes output. Part of the freeze key. */
  shaderVersion?: number;
  label: string;
  /** One line for the library and the node tooltip. */
  blurb: string;
  category: NodeCategory;
  family?: EffectFamily;
  domain: ExecDomain;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  temporal: TemporalDecl;
  impl: ImplDecl;
  determinism: DeterminismDecl;
  resources: ResourceDecl;
  /** L19 failure policy: the codes this node may raise. Unavailable nodes pass through (D6). */
  failure: { codes: ErrorCode[]; onUnavailable: 'pass-through' };
  /** Can a freeze boundary sit at this node's output. */
  freezable: boolean;
}
