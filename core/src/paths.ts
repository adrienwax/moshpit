// Path comparisons for the read-only source guarantee (Phase 0.4). Pure string work, so the UI,
// the worker and main share one rule. Windows semantics: case-insensitive, either slash.

/** Lower-case, backslashes, no trailing separator: two spellings of one folder compare equal. */
export function normPath(p: string): string {
  return p.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export const samePath = (a: string, b: string) => !!a.trim() && normPath(a) === normPath(b);

/** True when `child` is `parent` or anywhere below it. */
export function isInside(child: string, parent: string): boolean {
  const c = normPath(child), p = normPath(parent);
  return !!p && !!c && (c === p || c.startsWith(p + '\\'));
}

/** Either folder holds the other. */
export const overlaps = (a: string, b: string) => isInside(a, b) || isInside(b, a);

/** A render name that stays a file name: no separators, no reserved characters, no leading dots. */
export function safeFileName(name: string, fallback = 'render'): string {
  const s = name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  return s || fallback;
}
