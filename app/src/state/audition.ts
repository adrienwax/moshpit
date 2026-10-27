// Phase 2.2: audition. Selecting an effect in the browser shows it on the Program monitor, on the
// selected block, without touching the project: no undo step, no engine project update, no freeze.
// Apply commits it (one undo step); ending the audition leaves the project exactly as it was.
import type { Entry } from '../lib/browse';
import { compileBlockGraph, type BlockGraph } from '@moshpit/engine';
import { freeze } from 'immer';
import { blockFrames, blockStarts } from '../lib/timeline';
import { activeBlock, blockById, getDoc, isFrozen, projectStore, trialGraph } from './project';
import { trialRecipeGraph } from './recipes';
import { engine } from '../engine';
import { setUi, uiStore, type Audition } from './ui';

/** Keep the recipe identity: Apply must place its real graph and macros, not its search ingredients. */
export const auditionOf = (e: Entry, blockId: string): Audition | null =>
  e.type === 'recipe' ? (e.recipe.lookId || e.recipe.kinds.length ? { id: e.id, label: e.label, blockId, kinds: e.recipe.kinds, params: e.recipe.params, recipe: e.recipe } : null) : e.side === 'utility' ? null : { id: e.id, label: e.label, blockId, kinds: [e.id] };

const signature = (a: Audition) => JSON.stringify([a.id, a.blockId, a.kinds, a.params, a.recipe]);

/** Prepare once. A staged object is never silently rebuilt after its base or master changes. */
export function prepareAudition(a: Audition): Audition | null {
  if (a.candidate) return a;
  const current = uiStore.get().audition;
  if (current?.candidate && signature(current) === signature(a)) return current;
  const doc = getDoc(), block = blockById(doc, a.blockId as never);
  if (!block) return null;
  const look = a.recipe?.lookId ? doc.components?.looks.find((l) => l.id === a.recipe!.lookId) : undefined;
  const graph = a.recipe ? trialRecipeGraph(block, a.recipe, look ?? (a.recipe.lookId ? null : undefined)) : trialGraph(block, a.kinds, a.params);
  if (!graph || !compileBlockGraph(block.id, graph).ok) return null;
  return { ...a, candidate: { projectId: doc.id, base: block, graph: freeze(graph, true), look } };
}

/** The staged graph only belongs to the unchanged target, including its saved-look definition. */
export function auditionGraph(a: Audition): BlockGraph | null {
  const c = a.candidate, doc = getDoc();
  if (!c || doc.id !== c.projectId || blockById(doc, a.blockId as never) !== c.base || activeBlock(doc)?.id !== a.blockId || isFrozen(doc, { kind: 'block', blockId: c.base.id })) return null;
  if (a.recipe?.lookId && doc.components?.looks.find((l) => l.id === a.recipe!.lookId) !== c.look) return null;
  return c.graph;
}

let stopWatching: (() => void) | undefined;

/** Audition `a`. The playhead moves into the block if it is elsewhere: a third of the way in. */
export function startAudition(a: Audition): Audition | null {
  const staged = prepareAudition(a);
  if (!staged || !auditionGraph(staged)) { endAudition(); return null; }
  const blocks = getDoc().timeline.blocks;
  const i = blocks.findIndex((b) => b.id === a.blockId);
  if (i < 0) return null;
  const start = blockStarts(blocks)[i], len = blockFrames(blocks[i]);
  const p = uiStore.get().playhead;
  stopWatching?.();
  setUi({ audition: staged, ...(p >= start && p < start + len ? {} : { playhead: start + Math.floor(len / 3), playing: false }) });
  stopWatching = projectStore.subscribe(() => { if (!auditionGraph(staged)) endAudition(); });
  return staged;
}

export function endAudition() {
  stopWatching?.(); stopWatching = undefined;
  if (!uiStore.get().audition) return;
  setUi({ audition: undefined });
  engine.releaseTrials?.('audition'); // its engine is freed, not kept until the next trial
}

/** Shift-click: add to the comparison shortlist, or take it off. At most four; the oldest goes. */
export function toggleShortlist(a: Audition) {
  const s = uiStore.get().shortlist;
  const staged = prepareAudition(a);
  setUi({ shortlist: s.some((x) => x.id === a.id) ? s.filter((x) => x.id !== a.id) : staged ? [...s, staged].slice(-4) : s });
}
