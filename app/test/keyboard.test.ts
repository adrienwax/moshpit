import { describe, expect, it } from 'vitest';
import { blocksProjectHistoryTarget, blocksShortcutTarget } from '../src/lib/keyboard';

function element(tagName: string, attrs: Record<string, string> = {}, parentElement: unknown = null): EventTarget {
  return { tagName, getAttribute: (name: string) => attrs[name] ?? null, parentElement } as unknown as EventTarget;
}
describe('global shortcut focus boundaries', () => {
  it('leaves typed names, select navigation and focused button actions with their controls', () => {
    for (const name of ['input', 'TEXTAREA', 'select', 'button', 'summary', 'option']) expect(blocksShortcutTarget(element(name))).toBe(true);
    expect(blocksShortcutTarget(element('svg', {}, element('button')))).toBe(true);
  });
  it('recognizes editable ancestors and explicit non-editable islands', () => {
    const editor = element('div', { contenteditable: 'plaintext-only' });
    expect(blocksShortcutTarget(element('span', {}, editor))).toBe(true);
    expect(blocksShortcutTarget(element('span', {}, element('div', { contenteditable: 'false' }, editor)))).toBe(false);
    expect(blocksShortcutTarget(element('input', {}, element('div', { contenteditable: 'false' }, editor)))).toBe(true);
  });
  it('does not hijack custom slider/combobox keys, including nested readouts', () => {
    for (const role of ['slider', 'spinbutton', 'textbox', 'combobox']) expect(blocksShortcutTarget(element('span', {}, element('div', { role })))).toBe(true);
    expect(blocksShortcutTarget(element('div', { role: 'menu' }))).toBe(false);
  });
  it('keeps graph/canvas shortcuts available outside controls', () => {
    expect(blocksShortcutTarget(element('canvas'))).toBe(false);
    expect(blocksShortcutTarget(element('div'))).toBe(false);
    expect(blocksShortcutTarget(null)).toBe(false);
  });
});

describe('project history focus boundaries', () => {
  it('allows Undo/Redo from an ordinary focused toolbar button and its icon', () => {
    const button = element('button');
    expect(blocksProjectHistoryTarget(button)).toBe(false);
    expect(blocksProjectHistoryTarget(element('svg', {}, button))).toBe(false);
    expect(blocksShortcutTarget(button)).toBe(true); // Space/Enter are still the button's.
  });
  it('preserves text/value editor history, including editable ancestors of buttons', () => {
    for (const tag of ['input', 'textarea', 'select', 'option']) expect(blocksProjectHistoryTarget(element(tag))).toBe(true);
    for (const role of ['slider', 'spinbutton', 'textbox', 'combobox']) expect(blocksProjectHistoryTarget(element('button', {}, element('div', { role })))).toBe(true);
    const editor = element('div', { contenteditable: 'true' });
    expect(blocksProjectHistoryTarget(element('button', {}, editor))).toBe(true);
    expect(blocksProjectHistoryTarget(element('button', {}, element('div', { contenteditable: 'false' }, editor)))).toBe(false);
  });
  it('retains project history on canvas and non-control surfaces', () => {
    for (const target of [element('canvas'), element('div'), null]) expect(blocksProjectHistoryTarget(target)).toBe(false);
  });
});
