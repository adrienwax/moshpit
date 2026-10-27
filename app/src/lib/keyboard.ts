/** Keep application shortcuts out of controls, including a focused child inside a custom control. */
type KeyElement = {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  parentElement?: KeyElement | null;
};
const CONTROL_ROLES = new Set(['slider', 'spinbutton', 'textbox', 'combobox']);
export function blocksShortcutTarget(target: EventTarget | null): boolean {
  return blocksTarget(target, true);
}

/** Toolbar buttons do not own an undo stack; text/value editors still do. */
export function blocksProjectHistoryTarget(target: EventTarget | null): boolean {
  return blocksTarget(target, false);
}

function blocksTarget(target: EventTarget | null, protectButtons: boolean): boolean {
  let el = target as KeyElement | null;
  let allowEditableAncestor = true;
  while (el) {
    const tag = el.tagName?.toUpperCase() ?? '';
    if (/^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(tag) || (protectButtons && (tag === 'BUTTON' || tag === 'SUMMARY'))) return true;
    if (CONTROL_ROLES.has(el.getAttribute?.('role') ?? '')) return true;
    const editable = el.getAttribute?.('contenteditable');
    if (editable === 'false') allowEditableAncestor = false;
    if (allowEditableAncestor && (el.isContentEditable || editable === '' || editable === 'true' || editable === 'plaintext-only')) return true;
    el = el.parentElement ?? null;
  }
  return false;
}
