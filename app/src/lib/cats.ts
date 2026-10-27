import type { EffectFamily, LookCategory } from '@moshpit/engine';
export { CATS, DOMAIN_SHORT, edgeStyle, type Domain } from '../../../shared/ui/nodeStyle';

// Catalogue accents distinguish treatments. They never replace the typed socket/wire colours.
// The --cat-* family lives in shared/ui/tokens.css (A0.4); no category is red-family (caution only).
export const LOOK_COLOUR: Record<LookCategory, string> = {
  'Melt & Smear': 'var(--cat-melt)', 'Fracture & Displace': 'var(--cat-fracture)',
  'Stutter & Repeat': 'var(--cat-stutter)', 'Decay & Corrupt': 'var(--cat-decay)',
  'Echo & Trail': 'var(--cat-echo)', 'Colour & Split': 'var(--cat-colour)', Utility: 'var(--cat-utility)',
};

export const FAMILY_COLOUR: Record<EffectFamily, string> = {
  Bitstream: 'var(--cat-melt)', Plane: 'var(--cat-colour)', Feedback: 'var(--cat-echo)',
  Geometry: 'var(--cat-fracture)', Tone: 'var(--cat-stutter)', Degrade: 'var(--cat-decay)',
};
