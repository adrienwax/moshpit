export type View = { start: number; len: number };
export const MIN_LEN = 12;
/** Shared by the arrangement view and its scope sampling window. */
export const clampView = (v: View, total: number): View => {
  const len = Math.max(Math.min(MIN_LEN, total), Math.min(total, v.len));
  return { start: Math.max(0, Math.min(total - len, v.start)), len };
};
