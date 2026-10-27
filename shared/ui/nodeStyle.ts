export type EdgeType = 'EncodedVideoStream' | 'VideoFrame' | 'Field' | 'Scalar' | 'Event' | 'AudioBuffer';
export type FieldSubtype = string;
export type NodeCategory = 'Source' | 'Mosh' | 'Effect' | 'Routing' | 'Output' | 'Audio';
// L22: category is colour + badge + library group, consistent across tiles, sockets, slices.
// Polish 4 (9 Oct): on the design system's domain tokens. The legacy names (--sky, --coral, --lav…)
// collapse onto one function colour in the HUD theme, so Source, Mosh and Effect nodes all drew the
// same cyan. Now a node's colour says what it works on, as its sockets do (DESIGN-SYSTEM.md §2.5):
// stream ops amber, picture ops teal, plumbing grey, the clip neutral, the result green.
export const CATS: Record<NodeCategory, { accent: string; icon: string; desc: string }> = {
  Source: { accent: 'var(--txt-1)', icon: '▶', desc: 'clips, generators, stills — where media enters' },
  Mosh: { accent: 'var(--dom-enc)', icon: '✷', desc: 'datamosh / bitstream corruption — the signature category' },
  Effect: { accent: 'var(--dom-pix)', icon: '◆', desc: 'plane · feedback · geometry · tone · degrade' },
  Routing: { accent: 'var(--dom-ctl)', icon: '⤭', desc: 'mix · mask · delay — graph plumbing' },
  Output: { accent: 'var(--fn-valid)', icon: '⤓', desc: 'the image leaving the graph' },
  Audio: { accent: 'var(--fn-rec)', icon: '♪', desc: 'audio-mirror nodes (reserved)' },
};

/** The three port domains (DESIGN-SYSTEM.md §2.5): encoded stream, picture, control. */
export type Domain = 'enc' | 'pix' | 'ctl';
/** Short names for a refusal ("Needs PIX · got ENC"). */
export const DOMAIN_SHORT: Record<EdgeType, string> = { EncodedVideoStream: 'ENC', VideoFrame: 'PIX', Field: 'MASK', Scalar: 'CTL', Event: 'TRIG', AudioBuffer: 'AUDIO' };

/**
 * Typed edges (L3). Phase 1.2: in the design system's domain colours, encoded amber (dashed),
 * picture cyan, control grey. The old names (--rose, --sky, --lav) are re-pointed at function
 * colours by design.css, which drew every domain cyan.
 */
export function edgeStyle(type: EdgeType, subtype?: FieldSubtype): { stroke: string; width: number; dash?: string; label: string; domain: Domain } {
  switch (type) {
    case 'EncodedVideoStream':
      return { stroke: 'var(--dom-enc)', width: 2, dash: '6 3', label: 'encoded', domain: 'enc' };
    case 'VideoFrame':
      return { stroke: 'var(--dom-pix)', width: 2, label: 'image', domain: 'pix' };
    case 'Field':
      return { stroke: 'var(--dom-pix)', width: 2, dash: '1 3', label: subtype === 'Difference' ? 'difference' : 'mask', domain: 'pix' };
    case 'Scalar':
      return { stroke: 'var(--dom-ctl)', width: 1.5, dash: '2 3', label: 'number', domain: 'ctl' };
    case 'Event':
      return { stroke: 'var(--dom-ctl)', width: 1.5, dash: '1 3', label: 'trigger', domain: 'ctl' };
    case 'AudioBuffer':
      return { stroke: 'var(--dom-ctl)', width: 2, label: 'audio', domain: 'ctl' };
  }
}
