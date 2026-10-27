// The wiring rule (L1/L3/L4, §1f), shared by the stage-2 compiler and the editor so a wire the
// canvas accepts is exactly a wire the compiler accepts. Pure: safe in the UI renderer.

import type { EdgeType, NodeDef, PortDef } from '@moshpit/core';

export type WireVerdict =
  | { ok: true; conversion: 'none' | 'decode' | 'luma' }
  | { ok: false; reason: 'type' | 'domain' };

/**
 * Can an output of type `from` feed an input of type `to`?
 *   same type                         → direct
 *   EncodedVideoStream → VideoFrame   → the decode boundary; the planner inserts the Decode node
 *   VideoFrame → Field (Mask)         → read as luma (an inserted conversion)
 * Everything else is refused. Whether a decode edge is legal *here* (only from the end of the
 * block's encoded chain, one per block) is a graph-level check: `decodeAllowed`.
 */
export function canWire(from: EdgeType, to: EdgeType): WireVerdict {
  if (from === to) return { ok: true, conversion: 'none' };
  if (from === 'EncodedVideoStream' && to === 'VideoFrame') return { ok: true, conversion: 'decode' };
  if (from === 'VideoFrame' && to === 'Field') return { ok: true, conversion: 'luma' };
  return { ok: false, reason: 'type' };
}

/** Port-level form, for socket-drag filtering. */
export function canWirePorts(from: PortDef, to: PortDef): WireVerdict {
  return canWire(from.type, to.type);
}

/**
 * Encoded-domain nodes (Mosh: encoded in, encoded out) may only sit before the decode boundary
 * (B1). A wire from a frame-domain node into an encoded-domain node is always refused.
 */
export function domainOrderOk(fromDef: NodeDef, toDef: NodeDef): boolean {
  return !(fromDef.domain !== 'ENCODED_STREAM' && toDef.domain === 'ENCODED_STREAM');
}
