// L1–L3: what flows along an edge. An edge never carries "an image": it carries a typed descriptor
// the compiler negotiates. The type set is frozen here before node #1 (L3); adding to it is a
// graph-schema version bump, not a quiet change.

/** A rational number. Time is always one of these, never a float of seconds (L9). */
export interface Rational {
  num: number;
  den: number;
}

/** L3: the edge type set. `MotionVectorField` is reserved and has no producer in 3.0. */
export const EDGE_TYPES = ['VideoFrame', 'EncodedVideoStream', 'Field', 'Scalar', 'Event', 'AudioBuffer'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];
export const RESERVED_EDGE_TYPES = ['MotionVectorField'] as const;

/**
 * L3: `Field` subtypes. `motion` was renamed `Difference` on purpose: a frame-difference field
 * is what we can compute, and the name must not promise optical flow we do not have.
 */
export const FIELD_SUBTYPES = ['Mask', 'Difference'] as const;
export const RESERVED_FIELD_SUBTYPES = ['OpticalFlow', 'Depth'] as const;
export type FieldSubtype = (typeof FIELD_SUBTYPES)[number];

/** L17: the working pipeline is linear-light Rec.709, RGBA16F, premultiplied. */
export type PixelFormat = 'rgba8' | 'rgba16f' | 'r8' | 'r16f';
export type Transfer = 'bt709' | 'srgb' | 'linear';
export type AlphaMode = 'none' | 'premultiplied' | 'straight';

export interface FrameFormat {
  w: number;
  h: number;
  pixelFormat: PixelFormat;
  colorSpace: 'rec709';
  transfer: Transfer;
  primaries: 'bt709';
  range: 'tv' | 'pc';
  bitDepth: 8 | 16;
  alphaMode: AlphaMode;
  /** Pixel aspect ratio. 1/1 for everything the conform produces. */
  par: Rational;
}

export interface TimeDescriptor {
  /** Frame rate as a rational: 30000/1001, never 29.97. */
  fps: Rational;
}

export interface VideoFrameDescriptor {
  type: 'VideoFrame';
  storage: 'gpu' | 'cpu';
  format: FrameFormat;
  time: TimeDescriptor;
}

/**
 * L2 + L29: an encoded stream is its own type, and what an encoded-domain node may do to it is
 * stated as a capability, not assumed. Only a conform that meets the mosh contract sets
 * `moshable`; a decode-only fallback clip carries `moshable: false` and the compiler refuses to
 * wire it into an encoded-domain node.
 */
export interface EncodedCapabilities {
  /** Main profile, no B-frames, POC type 2, one reference frame, closed GOP. */
  moshable: boolean;
  /** Bits of `frame_num` in the slice header: what the renumbering layer rewrites. */
  frameNumBits: number;
  /** Byte-identical SPS/PPS across every clip conformed with the same settings, so blocks can be concatenated. */
  stitchable: boolean;
}

export interface EncodedStreamDescriptor {
  type: 'EncodedVideoStream';
  codec: 'h264';
  /** The WebCodecs codec string of the conform, e.g. `avc1.4d0028`. */
  codecString: string;
  width: number;
  height: number;
  time: TimeDescriptor;
  capabilities: EncodedCapabilities;
}

export interface FieldDescriptor {
  type: 'Field';
  subtype: FieldSubtype;
  /** Masks and differences are single-channel linear 0..1 (L17). */
  format: FrameFormat;
  time: TimeDescriptor;
}

export interface ScalarDescriptor {
  type: 'Scalar';
  min?: number;
  max?: number;
}

export interface EventDescriptor {
  type: 'Event';
}

/** L28: audio carries its own sample-rate descriptor; its clock is still derived from the frame clock. */
export type ChannelLayout = 'mono' | 'stereo' | '5.1';
export interface AudioDescriptor {
  type: 'AudioBuffer';
  sampleRate: number;
  channels: number;
  layout: ChannelLayout;
}

export type MediaDescriptor =
  | VideoFrameDescriptor
  | EncodedStreamDescriptor
  | FieldDescriptor
  | ScalarDescriptor
  | EventDescriptor
  | AudioDescriptor;
