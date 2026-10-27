import { MoshpitError, parseTargetPath, type ParamValue } from '@moshpit/engine';
import { applyControlWrite, type ControlWrite } from '../../../engine/src/control/params';
import { defForTarget } from '../../../engine/src/control/discovery';
import { getDoc, setBypass, setLfo, setParam } from './project';

/** Relative writes resolve at the committed UI store, so detents and concurrent mouse edits accumulate. */
export function commitControlWrite(write: ControlWrite, generation: number, projectId: string, expiresAt: number): ParamValue {
  const doc = getDoc();
  if (Date.now() >= expiresAt || doc.id !== projectId) throw new MoshpitError('CONTROL_STALE_TARGET', { why: 'expired write or changed project' });
  const target = parseTargetPath(write.target);
  const found = defForTarget(doc, write.target, generation);
  if (!target || !found) throw new MoshpitError('CONTROL_STALE_TARGET', { target: write.target });
  const value = applyControlWrite({ target: write.target, generation }, found.def, found.value, write);
  if (target.scope === 'node' && target.param === 'bypass') setBypass(target.blockId, target.nodeId, !!value);
  else if (target.scope === 'node') setParam(target.blockId, target.nodeId, target.param, value);
  else setLfo(target.lfoId, target.field === 'period' ? { period: Number(value) } : { phase: Number(value) }, `CT → LFO ${target.field}`);
  return defForTarget(getDoc(), write.target, generation)?.value ?? value;
}
