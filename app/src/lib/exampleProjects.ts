export interface ExampleProject {
  id: string; title: string; group: 'pixelord' | 'mix'; file: string;
  preview?: string; seconds: number; hint: string;
}
const localPath = (x: unknown): x is string => typeof x === 'string' && x.length < 2048 &&
  !x.includes('\0') && (/^[a-z]:[\\/]/i.test(x) || /^\/(?!\/)/.test(x));

/** Owner-local index only. No shipped personal paths or media, no directory scanning. */
export function parseExamples(raw: unknown): ExampleProject[] {
  if (raw == null) return [];
  const index = raw as { schemaVersion?: unknown; examples?: unknown };
  if (index.schemaVersion !== 1 || !Array.isArray(index.examples) || index.examples.length > 96)
    throw new Error('Example index needs schemaVersion 1 and up to 96 examples');
  const ids = new Set<string>();
  return index.examples.map((row: unknown) => {
    const x = row as ExampleProject;
    if (!x || typeof x.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(x.id) || ids.has(x.id) ||
        typeof x.title !== 'string' || !x.title.trim() || x.title.length > 120 ||
        !['pixelord', 'mix'].includes(x.group) || !localPath(x.file) || !/\.mosh$/i.test(x.file) ||
        (x.preview !== undefined && (!localPath(x.preview) || !/\.mp4$/i.test(x.preview))) ||
        !Number.isFinite(x.seconds) || x.seconds <= 0 || x.seconds > 3600 ||
        typeof x.hint !== 'string' || x.hint.length > 500) throw new Error('Invalid or duplicate example entry');
    ids.add(x.id);
    return { id: x.id, title: x.title, group: x.group, file: x.file,
      preview: x.preview, seconds: x.seconds, hint: x.hint };
  });
}
