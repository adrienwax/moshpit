import type { NodeDef, ParamValue } from '@moshpit/engine';

export interface SavedEffectPreset { id: string; name: string; params: Record<string, ParamValue> }
export type EffectPresetLibrary = Record<string, SavedEffectPreset[]>;
export const MAX_EFFECT_PRESETS = 50;
export const presetName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, 80);

/** Settings are external data. Retain unknown kinds for future versions, never arbitrary objects. */
export function sanitizeEffectPresets(raw: unknown): EffectPresetLibrary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([kind, list]) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(kind) || !Array.isArray(list)) return [];
    const names = new Set<string>(), ids = new Set<string>();
    const entries: SavedEffectPreset[] = list.flatMap((value): SavedEffectPreset[] => {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.params || typeof value.params !== 'object' || Array.isArray(value.params)) return [];
      const name = presetName(value.name), id = value.id.slice(0, 120);
      if (!name || names.has(name.toLowerCase()) || ids.has(id)) return [];
      names.add(name.toLowerCase()); ids.add(id);
      const params = Object.fromEntries(Object.entries(value.params).filter(([k, v]) => k.length <= 100 && (typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean' || typeof v === 'string' && v.length <= 200))) as Record<string, ParamValue>;
      return [{ id, name, params }];
    }).slice(0, MAX_EFFECT_PRESETS);
    return entries.length ? [[kind, entries]] : [];
  }));
}

/** Store declared base values only: no node identity, wiring, bypass or modulation bindings. */
export function effectPresetValues(def: NodeDef, raw: Record<string, ParamValue>): Record<string, ParamValue> {
  return Object.fromEntries(def.params.map(p => {
    const fallback = p.initial ?? p.default, v = raw[p.key] ?? fallback;
    let value: ParamValue = fallback;
    if (p.type === 'bool') value = typeof v === 'boolean' ? v : fallback;
    else if (p.type === 'enum') value = typeof v === 'string' && p.options?.includes(v) ? v : fallback;
    else if (typeof v === 'number' && Number.isFinite(v)) value = Math.min(p.max ?? v, Math.max(p.min ?? v, p.type === 'int' ? Math.round(v) : v));
    return [p.key, value];
  }));
}

export function matchingEffectPreset(def: NodeDef, values: Record<string, ParamValue>, presets: readonly SavedEffectPreset[]): SavedEffectPreset | undefined {
  const current = effectPresetValues(def, values);
  return presets.find(p => {
    const expected = effectPresetValues(def, p.params);
    return def.params.every(d => expected[d.key] === current[d.key]);
  });
}

export function putEffectPreset(library: EffectPresetLibrary, def: NodeDef, name: string, values: Record<string, ParamValue>, id: string): EffectPresetLibrary {
  const clean = presetName(name);
  if (!clean) throw Error('Give the preset a name.');
  const list = library[def.kind] ?? [];
  const collision = list.find(p => p.name.toLowerCase() === clean.toLowerCase() && p.id !== id);
  if (collision) throw Error(`A preset named “${clean}” already exists. Choose another name or replace it explicitly.`);
  if (!list.some(p => p.id === id) && list.length >= MAX_EFFECT_PRESETS) throw Error(`This effect already has ${MAX_EFFECT_PRESETS} saved presets. Remove one before saving another.`);
  const next = { id, name: clean, params: effectPresetValues(def, values) };
  return { ...library, [def.kind]: list.some(p => p.id === id) ? list.map(p => p.id === id ? next : p) : [...list, next] };
}

export function removeEffectPreset(library: EffectPresetLibrary, kind: string, id: string): EffectPresetLibrary {
  const next = { ...library, [kind]: (library[kind] ?? []).filter(p => p.id !== id) };
  if (!next[kind].length) delete next[kind];
  return next;
}
