/** Public project names; the JSON schema is independent of the filename extension. */
export const PROJECT_EXTENSION = '.mosh';
const projectSuffix = /\.(?:moshpit\.json|moshpit|mosh|json)$/i;

export const projectFileStem = (file: string): string => file.replace(/^.*[\\/]/, '').replace(projectSuffix, '');

export function projectSavePath(file: string): string {
  if (/\.mosh$/i.test(file)) return file;
  return file.replace(projectSuffix, '') + PROJECT_EXTENSION;
}

export function suggestedProjectFile(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return projectSavePath(safe || 'Untitled');
}
