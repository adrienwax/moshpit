import { newId, type ComponentDef } from '@moshpit/engine';
import { parsePortableLook, serializePortableLook, lookProblem } from '../../../engine/src/project/lookIO';
import { host } from '../host';
import { commit, getDoc, projectLooks } from './project';

/** A copied library definition, one undo, never a replacement or an automatic graph edit. */
export function importLookText(text: string, expectedProjectId = getDoc().id): ComponentDef {
  const parsed = parsePortableLook(text);
  if (getDoc().id !== expectedProjectId) lookProblem('The project changed while choosing a look. Import it again into the intended project.');
  const names = new Set(projectLooks(getDoc()).map(l => l.name.toLowerCase()));
  let name = parsed.name;
  for (let i = 2; names.has(name.toLowerCase()); i++) name = `${parsed.name.slice(0, 74)} ${i}`;
  const copy: ComponentDef = { ...parsed, id: newId(), name, rev: 1 };
  commit(`Import look: ${name}`, d => { (d.components ??= { looks: [] }).looks.push(copy); });
  return copy;
}

export async function importLookDialog(): Promise<ComponentDef | null> {
  if (!host.looks) return lookProblem('Look file import is available in the desktop app.');
  const project = getDoc().id;
  const result = await host.looks.import();
  if (!result.ok) throw result.error;
  return result.value === null ? null : importLookText(result.value, project);
}

export async function exportLookDialog(id: string): Promise<string | null> {
  if (!host.looks) return lookProblem('Look file export is available in the desktop app.');
  const look = projectLooks(getDoc()).find(l => l.id === id);
  if (!look) return lookProblem('This saved look was removed. Save the container as a look again.');
  // Capture the master now; a later project edit cannot change what the dialog exports.
  const text = serializePortableLook(look);
  const result = await host.looks.export(text);
  if (!result.ok) throw result.error;
  return result.value;
}
