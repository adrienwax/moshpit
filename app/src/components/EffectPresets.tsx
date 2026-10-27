import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PRESETS, type NodeDef, type ParamValue } from '@moshpit/engine';
import { effectPresetValues, matchingEffectPreset, presetName, putEffectPreset, removeEffectPreset, type SavedEffectPreset } from '../lib/effectPresets';
import { updateSettingsDurably, useSettings } from '../state/ui';
import { confirmAction, toast } from '../qol/qol';

/** App-scoped value presets. Graph identity, wiring and modulation stay with the selected node. */
export function EffectPresets({ def, values, onApply, disabled, extra }: {
  def: NodeDef;
  values: Record<string, ParamValue>;
  onApply: (name: string, values: Record<string, ParamValue>) => void;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const library = useSettings(s => s.effectPresets);
  const mine = library[def.kind] ?? [];
  const builtIn = PRESETS[def.kind] ?? [];
  const current = matchingEffectPreset(def, values, mine);
  const built = matchingEffectPreset(def, values, builtIn.map((p, i) => ({ ...p, id: String(i) })));
  const [naming, setNaming] = useState<'save' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [renameTarget, setRenameTarget] = useState<SavedEffectPreset | null>(null);
  const pending = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!def.params.length) return null;
  const save = async () => {
    const clean = presetName(name);
    if (!clean || pending.current || disabled) return;
    // Lock before awaiting confirmation: repeated Enter must not open two prompts or queue two saves.
    pending.current = true;
    const mode = naming, capturedValues = structuredClone(values);
    const old = mode === 'rename' ? renameTarget : mine.find(p => p.name.toLowerCase() === clean.toLowerCase());
    setBusy(true); setError('');
    try {
      if (mode === 'save' && old && !(await confirmAction(`Replace “${old.name}”?`, 'Only this saved preset changes. Effects already placed in projects keep their values.', 'Replace preset'))) return;
      if (!alive.current) return; // a node switch unmounts this keyed panel; don't save from its old prompt
      const id = old?.id ?? crypto.randomUUID();
      await updateSettingsDurably(s => {
        const latest = mode === 'rename' && old ? s.effectPresets[def.kind]?.find(p => p.id === old.id) : undefined;
        if (mode === 'rename' && !latest) throw Error('This preset no longer exists. Choose it again.');
        s.effectPresets = putEffectPreset(s.effectPresets, def, clean, latest?.params ?? capturedValues, id);
      });
      if (alive.current) setNaming(null);
      toast(`${mode === 'rename' ? 'Renamed' : 'Saved'} ${clean} · available for ${def.label} in every project`, { kind: 'ok' });
    } catch (e) { if (alive.current) setError(`Preset not saved. ${e instanceof Error ? e.message : String(e)}`); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const remove = async () => {
    if (!current || pending.current || disabled) return;
    pending.current = true;
    const target = current;
    setBusy(true); setError('');
    try {
      if (!(await confirmAction(`Delete “${target.name}”?`, 'It leaves this app’s preset library. Effects already placed in projects are unchanged.', 'Delete preset')) || !alive.current) return;
      await updateSettingsDurably(s => { s.effectPresets = removeEffectPreset(s.effectPresets, def.kind, target.id); });
      toast(`Deleted preset ${target.name}`, { kind: 'ok' });
    } catch (e) { if (alive.current) setError(`Preset not deleted. ${e instanceof Error ? e.message : String(e)}`); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="effect-presets" data-help-label="Presets" title="Presets save parameter values. Connections, bypass and modulation stay on the node.">
    <div className="minilabel">Presets</div>
    <div className="presetrow">
      <select aria-label={`${def.label} preset`} disabled={disabled || busy} value={current ? `user:${current.id}` : built ? `built:${built.id}` : ''} onChange={e => {
        const value = e.target.value;
        const p = value.startsWith('user:') ? mine.find(p => p.id === value.slice(5)) : builtIn[Number(value.slice(6))];
        if (p) onApply(p.name, effectPresetValues(def, p.params));
      }}>
        <option value="" disabled>Modified / starting values</option>
        {builtIn.length > 0 && <optgroup label="Classic v1">{builtIn.map((p, i) => <option value={`built:${i}`} key={p.name}>{p.name}</option>)}</optgroup>}
        {mine.length > 0 && <optgroup label="My presets">{mine.map(p => <option value={`user:${p.id}`} key={p.id}>{p.name}</option>)}</optgroup>}
      </select>
      <button className="preset" disabled={disabled || busy} onClick={() => onApply('default', effectPresetValues(def, {}))}>Default</button>
      {extra}
    </div>
    <div className="presetrow">
      <button className="ghostbtn" title="Save these parameter values as a preset. Connections, bypass and modulation stay on the node." disabled={disabled || busy} onClick={() => { setName(current?.name ?? ''); setNaming('save'); setError(''); }}>Save preset…</button>
      <button className="ghostbtn" disabled={disabled || busy || !current} onClick={() => { setRenameTarget(current!); setName(current!.name); setNaming('rename'); setError(''); }}>Rename</button>
      <button className="ghostbtn" disabled={disabled || busy || !current} onClick={() => void remove()}>Delete</button>
    </div>
    {naming && <form className="preset-name" onSubmit={e => { e.preventDefault(); void save(); }} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape' && !busy) setNaming(null); }}>
      <input autoFocus aria-label="Preset name" maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder="e.g. Soft coral trail" />
      <button className="pop" type="submit" disabled={busy || !presetName(name)}>{busy ? 'Saving…' : naming === 'rename' ? 'Rename' : 'Save'}</button>
      <button className="ghostbtn" type="button" disabled={busy} onClick={() => setNaming(null)}>Cancel</button>
    </form>}
    {error && <p role="alert" className="preset-error">{error}</p>}
  </div>;
}
