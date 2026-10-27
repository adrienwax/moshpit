// V1's stage → tune → add workflow, on v3's typed catalogue. Pure data: no project writes.
import { PRESETS, macroParams, macroValue, stampLook, type ComponentDef, type ParamDef, type ParamValue } from '@moshpit/engine';
import { defOf } from '../engine';
import type { Entry } from './browse';
import type { Audition } from '../state/ui';
import type { Recipe } from '../state/recipes';

export interface DraftControl { id: string; at: number | 'look'; key: string; spec: ParamDef }
export interface EffectDraft {
  entryId: string;
  label: string;
  blockId: string;
  params: NonNullable<Recipe['params']>;
  recipe?: Recipe;
  controls: DraftControl[];
  previewable: boolean;
  preset: string;
  presetKey?: string;
}
const initial = (p: ParamDef) => p.initial ?? p.default;
const defaults = (kind: string) => Object.fromEntries((defOf(kind)?.params ?? []).map(p => [p.key, initial(p)]));

export function makeEffectDraft(e: Entry, blockId: string, look?: ComponentDef): EffectDraft {
  const recipe = e.type === 'recipe' ? structuredClone(e.recipe) : undefined;
  const kinds = recipe?.kinds ?? [e.id];
  const params = kinds.map((k, i) => ({ ...defaults(k), ...recipe?.params?.[i] }));
  let controls: DraftControl[] = [];
  if (recipe?.lookId && look) {
    const instance = stampLook(look, { x: 0, y: 0 });
    recipe.lookParams = Object.fromEntries(macroParams(instance).map(p => [p.key, macroValue(instance, p.key)]));
    controls = macroParams(instance).map(spec => ({ id: `look|${spec.key}`, at: 'look', key: spec.key, spec }));
  } else if (recipe) {
    controls = (recipe.macros ?? []).flatMap((m, i) => {
      const p = defOf(kinds[m.at])?.params.find(p => p.key === m.param);
      if (!p) return [];
      const from = m.from ?? p.min, to = m.to ?? p.max;
      const value = params[m.at]?.[m.param];
      return [{ id: `${m.at}|${m.param}`, at: m.at, key: m.param, spec: { ...p, label: m.label, help: m.help, default: typeof value === 'object' || value === undefined ? initial(p) : value, ...(from !== undefined && to !== undefined ? { min: Math.min(from, to), max: Math.max(from, to) } : {}), ctOrder: (i + 1) as ParamDef['ctOrder'] } }];
    });
    recipe.params = params;
  } else {
    controls = [...(e.type === 'node' ? e.def.params : [])].sort((a, b) =>
      Number(!!b.onNode) - Number(!!a.onNode) || (a.ctOrder ?? 99) - (b.ctOrder ?? 99),
    ).map(spec => ({ id: `0|${spec.key}`, at: 0, key: spec.key, spec }));
  }
  return { entryId: e.id, label: e.label, blockId, params, recipe, controls,
    previewable: e.type === 'recipe' ? !!(recipe?.lookId && look || kinds.length) : e.side !== 'utility', preset: 'Starting point' };
}

export function draftValue(d: EffectDraft, c: DraftControl): ParamValue {
  return (c.at === 'look' ? d.recipe?.lookParams?.[c.key] : d.params[c.at]?.[c.key]) ?? c.spec.default;
}

/** Reject invalid values at the draft boundary, before either audition or Apply sees them. */
function safeValue(spec: ParamDef, v: ParamValue): ParamValue | undefined {
  if (spec.type === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (spec.type === 'enum') return typeof v === 'string' && spec.options?.includes(v) ? v : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = spec.type === 'int' ? Math.round(v) : v;
  return Math.min(spec.max ?? n, Math.max(spec.min ?? n, n));
}

export function changeDraft(d: EffectDraft, id: string, raw: ParamValue): EffectDraft {
  const c = d.controls.find(c => c.id === id);
  if (!c) return d;
  const value = safeValue(c.spec, raw);
  if (value === undefined) return d;
  if (c.at === 'look') return { ...d, preset: 'Modified', presetKey: undefined, recipe: { ...d.recipe!, lookParams: { ...d.recipe?.lookParams, [c.key]: value } } };
  const params = d.params.map((p, i) => i === c.at ? { ...p, [c.key]: value } : p);
  return { ...d, preset: 'Modified', presetKey: undefined, params, ...(d.recipe ? { recipe: { ...d.recipe, params } } : {}) };
}

export function presetDraft(d: EffectDraft, name: string): EffectDraft {
  if (d.recipe) return d;
  const preset = PRESETS[d.entryId]?.find(p => p.name === name);
  if (!preset) return d;
  return valuesDraft(d, name, preset.params, `built:${name}`);
}

export function valuesDraft(d: EffectDraft, name: string, values: Record<string, ParamValue>, key?: string): EffectDraft {
  if (d.recipe) return d;
  let next: EffectDraft = { ...d, params: [{ ...defaults(d.entryId) }] };
  for (const c of d.controls) if (values[c.key] !== undefined) next = changeDraft(next, c.id, values[c.key]);
  return { ...next, preset: name, presetKey: key };
}

export function auditionDraft(d: EffectDraft): Audition | null {
  if (!d.previewable) return null;
  return { id: d.entryId, label: d.label, blockId: d.blockId, kinds: d.recipe?.kinds ?? [d.entryId], params: d.params, ...(d.recipe ? { recipe: d.recipe } : {}) };
}

/** A comparison candidate restores its tuned values, not another copy of the catalogue defaults. */
export function restoreDraft(d: EffectDraft, a: Audition): EffectDraft {
  if (d.entryId !== a.id || d.blockId !== a.blockId) return d;
  const params = structuredClone(a.params ?? d.params);
  const recipe = a.recipe ? { ...structuredClone(a.recipe), params } : d.recipe;
  return { ...d, params, recipe, preset: 'Shortlisted settings', presetKey: undefined };
}

/** A draft belongs to the original block. A different selection never silently retargets it. */
export function draftTargetIssue(d: EffectDraft, activeId: string | undefined, exists: boolean, frozen: boolean): string | null {
  if (!exists) return 'The target block was removed. Select a block and choose the effect again.';
  if (d.blockId !== activeId) return 'The selected block changed. Choose the effect again for this block.';
  if (frozen) return 'The target block is frozen. Unfreeze it before adding effects.';
  return null;
}
