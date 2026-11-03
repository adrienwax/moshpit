export interface ExampleProject {
  id: string; title: string; group: 'pixelord' | 'mix'; file: string;
  preview?: string; seconds: number; hint: string;
  collection?: 'bundled' | 'local'; unavailable?: string;
}
const localPath = (x: unknown): x is string => typeof x === 'string' && x.length < 2048 &&
  !x.includes('\0') && (/^[a-z]:[\\/]/i.test(x) || /^\/(?!\/)/.test(x));

/** Main resolves bundled and owner-local entries. No directory scanning in the renderer. */
export function parseExamples(raw: unknown): ExampleProject[] {
  if (raw == null) return [];
  const index = raw as { schemaVersion?: unknown; examples?: unknown };
  if (index.schemaVersion !== 1 || !Array.isArray(index.examples) || index.examples.length > 128)
    throw new Error('Example index needs schemaVersion 1 and up to 128 examples');
  const ids = new Set<string>();
  return index.examples.map((row: unknown) => {
    const x = row as ExampleProject;
    if (!x || typeof x.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(x.id) || ids.has(x.id) ||
        typeof x.title !== 'string' || !x.title.trim() || x.title.length > 120 ||
        !['pixelord', 'mix'].includes(x.group) || !localPath(x.file) || !/\.mosh$/i.test(x.file) ||
        (x.preview !== undefined && (!localPath(x.preview) || !/\.mp4$/i.test(x.preview))) ||
        (x.collection !== undefined && !['bundled', 'local'].includes(x.collection)) ||
        (x.unavailable !== undefined && (typeof x.unavailable !== 'string' || !x.unavailable.trim() || x.unavailable.length > 240)) ||
        !Number.isFinite(x.seconds) || x.seconds <= 0 || x.seconds > 3600 ||
        typeof x.hint !== 'string' || x.hint.length > 500) throw new Error('Invalid or duplicate example entry');
    ids.add(x.id);
    return { id: x.id, title: x.title, group: x.group, file: x.file,
      preview: x.preview, seconds: x.seconds, hint: x.hint, collection: x.collection ?? 'local', unavailable: x.unavailable };
  });
}

/** Search only visible teaching metadata, never private file paths. */
export function filterExamples(rows: ExampleProject[], query: string, group: string): ExampleProject[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => (group === 'all' || row.group === group) &&
    terms.every(term => `${row.title} ${row.hint}`.toLocaleLowerCase().includes(term)));
}

export function exampleIndexWarning(raw: unknown): string {
  const warning = (raw as { warning?: unknown } | null)?.warning;
  return typeof warning === 'string' && warning.length <= 240 ? warning : '';
}
