// Op chains on the engine's real kinds (Moshpit 1 / cookbook flavours). Mosh ops land before the
// decode boundary and image ops before Output, whatever order they are listed in. Phase 2.1: each
// recipe is filed under the look it makes, so the effect browser shows it beside its ingredients.
// Polish 7: the starter looks, each a nameable datamosh look built from what read best in the
// dogfood demos. 3.2 Phase 3 (recipe merge): applying a look places it as a CONTAINER named after
// it, with 3-4 authored macros on its face (and the CT's dials); the chain inside is spliced exactly
// as before, so it renders the same until a macro is turned.
import { collapseSelection, compileBlockGraph, newId, type Block, type BlockGraph, type ComponentDef, type EdgeId, type LookCategory, type Macro, type NodeId, type NodeInstance, type ParamValue } from '@moshpit/engine';
import { appendEffect, collapseNodes, commit, getDoc, nodesOf, placeLook, ports, setBlock, transact, trialGraph, DECODE_KIND } from './project';
import { defOf } from '../engine';
import { toast } from '../qol/qol';

/** An authored macro: a dial over one step's param, across `from`..`to` (default: the param's range). */
export interface RecipeMacro { at: number; param: string; label: string; help: string; from?: number; to?: number }

export interface Recipe {
  ic: string;
  nm: string;
  kinds: string[];
  /** Per step, over that node's starting values (index-aligned with `kinds`). */
  params?: (Record<string, ParamValue> | undefined)[];
  /** The look needs the block to be this kind (the I-frame bloom needs a motion block). */
  blockKind?: 'motion';
  /** One line on how to get the look, when it is more than a chain. */
  how?: string;
  src: string;
  look: LookCategory;
  does: string;
  /** 3.3 / D4: the knobs on the look's container (3-6). */
  macros?: RecipeMacro[];
  /** 3.6: one of your own looks in the project library (placed with placeLook, not spliced as a chain). */
  lookId?: string;
  /** Staged knob positions for a saved look; applied to its new copy, never to the master. */
  lookParams?: Record<string, ParamValue>;
}

const M = (at: number, param: string, label: string, help: string, from?: number, to?: number): RecipeMacro => ({ at, param, label, help, from, to });

export const RECIPES: Recipe[] = [
  // ── starter looks ──
  { ic: '✷', nm: 'Melt', kinds: ['mosh.hold', 'fx.drift-trail'], params: [{ span: 4, times: 12 }, { amount: 65, back: 4, driftX: 0, driftY: 8 }], src: 'starter', look: 'Melt & Smear', does: 'The picture pours downward: held motion piled up, with a trail that slides off it.' , macros: [M(0, 'times', 'Pour', 'How many times the held motion piles up', 2, 60), M(0, 'span', 'Length', 'How many frames each hold repeats', 1, 12), M(1, 'amount', 'Smear', 'How strong the trail is'), M(1, 'driftY', 'Fall', 'How far the trail slides downward', 0, 60)] },
  { ic: '✷', nm: 'I-frame Bloom', kinds: [], blockKind: 'motion', src: 'starter', look: 'Melt & Smear', does: 'The old picture blooms into the new motion at the cut, the signature datamosh transition.', how: 'Makes this block a motion block. Put a picture block before it; for a cut inside one clip, import the part after the cut as its own clip (IN at the cut), or it will not bloom.' },
  { ic: '◆', nm: 'Chroma Ghost', kinds: ['fx.plane-desync-temporal', 'fx.chroma-trail'], params: [{ pastR: true, pastG: false, pastB: true, back: 5 }, { amount: 70, spread: 80 }], src: 'starter', look: 'Colour & Split', does: 'Moving things leave red and blue ghosts that lag behind them in time.' , macros: [M(0, 'back', 'Lag', 'How far behind the colour ghosts trail'), M(1, 'amount', 'Ghost', 'How strong the ghosts are'), M(1, 'spread', 'Spread', 'How far red and blue split apart')] },
  { ic: '◆', nm: 'Feedback Trail', kinds: ['fx.feedback-trail', 'fx.echo-taps'], params: [{ amount: 80, back: 2 }, { taps: 3, spacing: 3 }], src: 'starter', look: 'Echo & Trail', does: 'Long smeared trails with stepped echoes in them: motion becomes a streak.' , macros: [M(0, 'amount', 'Trail', 'How long the smear lasts'), M(0, 'back', 'Length', 'How far back the trail reaches'), M(1, 'taps', 'Echoes', 'How many stepped echoes'), M(1, 'spacing', 'Spacing', 'Frames between the echoes')] },
  { ic: '✷', nm: 'Pixel Drift', kinds: ['mosh.reorder', 'fx.pixel-stretch'], params: [{ mode: 'pingpong' }, { mode: 'wave', reach: 45, speed: 50 }], src: 'starter', look: 'Fracture & Displace', does: 'Motion folds back on itself while a wave of stretched pixels drags across the frame.' , macros: [M(1, 'reach', 'Reach', 'How far the pixels stretch'), M(1, 'speed', 'Speed', 'How fast the wave moves'), M(1, 'origin', 'Origin', 'Where the stretch starts')] },
  // ── recipes ──
  { ic: '✷', nm: 'VHS Decay', kinds: ['mosh.hold', 'fx.chroma-drift', 'fx.posterize'], src: 'v2', look: 'Decay & Corrupt', does: 'A held smear with colour bleeding off it and banded gradients: worn tape.' , macros: [M(0, 'times', 'Smear', 'How much the held motion piles up', 2, 60), M(1, 'cb', 'Bleed blue', 'Blue colour bleed', 0, 128), M(1, 'cr', 'Bleed red', 'Red colour bleed', 0, -128), M(2, 'levels', 'Crunch', 'Fewer levels, harder bands', 32, 2)] },
  { ic: '✷', nm: 'Hard Datamosh', kinds: ['mosh.stride', 'mosh.hold'], src: 'v2', look: 'Melt & Smear', does: 'A stepped, lurching smear that then piles up: the loud classic mosh.' , macros: [M(0, 'every', 'Stride', 'How far apart the lurches are'), M(1, 'times', 'Pile', 'How much the smear piles up', 2, 60), M(1, 'span', 'Span', 'Frames per hold', 1, 30)] },
  { ic: '◆', nm: 'Dream Melt', kinds: ['fx.feedback-trail', 'fx.soft-blur'], src: 'cookbook', look: 'Melt & Smear', does: 'Soft trails that melt into blur: motion turns to slow liquid.' , macros: [M(0, 'amount', 'Trail', 'How long the trails last'), M(0, 'back', 'Length', 'How far back they reach'), M(1, 'radius', 'Blur', 'How soft the melt is')] },
  { ic: '◆', nm: 'Ghost Echo', kinds: ['fx.echo-taps', 'fx.chroma-trail'], src: 'cookbook', look: 'Echo & Trail', does: 'Distinct ghost copies of moving things, split into colour.' , macros: [M(0, 'taps', 'Echoes', 'How many ghost copies'), M(0, 'spacing', 'Spacing', 'Frames between the copies'), M(0, 'amount', 'Ghost', 'How strong the copies are'), M(1, 'spread', 'Split', 'How far the colours split')] },
  { ic: '✷', nm: 'Beat Chop', kinds: ['mosh.pingpong', 'fx.resolution-crush'], src: 'v2', look: 'Stutter & Repeat', does: 'Motion folding back and forth under big chunky pixels, for a drop.' , macros: [M(0, 'laps', 'Laps', 'How many times the motion folds back'), M(0, 'pause', 'Pause', 'Frames held at each turn'), M(1, 'factor', 'Crunch', 'How chunky the pixels are')] },
];

/** One recipe step means one instance, even when two steps share a node kind. */
function recipeMacros(r: Recipe, added: NodeInstance[]): Macro[] {
  return (r.macros ?? []).flatMap((m, i) => {
    const p = defOf(r.kinds[m.at])?.params.find((x) => x.key === m.param);
    const node = added[m.at];
    if (!node || !p || p.min === undefined || p.max === undefined) return [];
    return [{ key: `macro${i + 1}` as never, label: m.label, help: m.help, min: 0, max: 1, default: 0, target: { node: node.id, param: m.param as never }, map: { from: m.from ?? p.min, to: m.to ?? p.max, curve: 'linear' as const } }];
  });
}

const groupedTrials = new WeakMap<BlockGraph, Map<string, BlockGraph | null>>();
/** Build the complete preview candidate once, including the container and authored macro face. */
export function trialRecipeGraph(block: Block, r: Recipe, look?: ComponentDef | null): BlockGraph | null {
  if (r.blockKind) return null; // timeline-kind recipes need a timeline preview, not a graph replacement
  if (r.lookId && !look) return null;
  const graph = trialGraph(block, r.kinds, r.params, look, r.lookParams);
  if (!graph || r.lookId) return graph;
  const key = JSON.stringify([r.nm, r.macros]);
  const memo = groupedTrials.get(graph) ?? new Map<string, BlockGraph | null>();
  groupedTrials.set(graph, memo);
  if (!memo.has(key)) {
    const before = new Set(block.graph.nodes.map((n) => n.id));
    const added = graph.nodes.filter((n) => !before.has(n.id));
    const domains = new Set(added.map((n) => defOf(n.kind)?.domain === 'ENCODED_STREAM'));
    const decode = domains.size > 1 ? graph.nodes.find((n) => n.kind === DECODE_KIND) : undefined;
    const container = newId<NodeId>();
    try {
      const grouped = collapseSelection(graph, [...added.map((n) => n.id), ...(decode ? [decode.id] : [])], { container, groupIn: newId<NodeId>(), groupOut: newId<NodeId>(), edge: () => newId<EdgeId>() }, (n, port) => ports(n, 'out').find((p) => p.key === port)?.type);
      const box = grouped.nodes.find((n) => n.id === container)!;
      box.label = r.nm;
      box.body!.macros = recipeMacros(r, added);
      box.body!.origin = { component: `builtin:${r.nm}` as never, rev: 1 };
      memo.set(key, compileBlockGraph(block.id, grouped).ok ? grouped : null);
    } catch { memo.set(key, null); }
  }
  return memo.get(key)!;
}

/**
 * Apply a recipe to a block: its kind if it sets one, then its chain. One undo step. Returns false
 * when nothing changed. The first block must stay a picture block (a motion block has no picture
 * to move: TIMELINE_NO_PICTURE), so a kind change there is skipped and the user is told why
 * (final audit P2: the I-frame Bloom on block 1).
 */
export function applyRecipe(blockId: string, r: Recipe): boolean {
  if (r.lookId) return placeLook(blockId as never, r.lookId, r.lookParams) !== null;
  const first = getDoc().timeline.blocks[0]?.id === blockId;
  const kind = r.blockKind && !first ? r.blockKind : undefined;
  if (r.blockKind && first) toast(`${r.nm} needs a picture block before it: the first block must be a picture block. Apply it to a later block.`, { kind: 'warn' });
  if (!kind && !r.kinds.length) return false;
  transact(() => {
    if (kind) setBlock(blockId as never, { kind }, `${r.nm}: motion block`);
    if (!r.kinds.length) return;
    const graph = () => getDoc().timeline.blocks.find((b) => b.id === blockId)!.graph;
    const before = new Set(graph().nodes.map((n) => n.id));
    r.kinds.forEach((k, i) => appendEffect(blockId as never, k, r.params?.[i]));
    const g = graph();
    const added = g.nodes.filter((n) => !before.has(n.id));
    if (added.length !== r.kinds.length) return; // a block without a chain: the nodes stay loose, as before
    // A look across the Decode (stream ops and picture ops) takes the block's Decode inside it (D2):
    // one way in (the stream), one way out (the picture).
    const domains = new Set(added.map((n) => defOf(n.kind)?.domain === 'ENCODED_STREAM'));
    const dec = domains.size > 1 ? g.nodes.find((n) => n.kind === DECODE_KIND) : undefined;
    const c = collapseNodes(blockId as never, [...added.map((n) => n.id), ...(dec ? [dec.id] : [])], r.nm);
    const macros = recipeMacros(r, added);
    commit(`${r.nm}: its macros`, (d) => {
      const box = d.timeline.blocks.find((b) => b.id === blockId)!.graph.nodes.find((n) => n.id === c)!;
      box.body!.macros = macros;
      box.body!.origin = { component: `builtin:${r.nm}` as never, rev: 1 };
    });
  });
  return true;
}

/** Every node a look placed, inside its container or not. */
export const lookNodes = (blockId: string) => nodesOf(getDoc().timeline.blocks.find((b) => b.id === blockId)!);
