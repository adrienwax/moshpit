import { describe, expect, it, vi } from 'vitest';
import { beginEffectBrowserFocus } from '../src/ws/mosh/EffectBrowser';

// Exercise the focus lifecycle against only its DOM contract, without another DOM dependency.
function scene() {
  let active: unknown;
  function element(text = '') {
    const attrs = new Map<string, string>();
    const e = {
      isConnected: true, inert: false, hidden: false, disabled: false, textContent: text,
      children: [] as unknown[],
      focus: vi.fn(() => { active = e; }), select: vi.fn(),
      contains: (child: unknown) => e.children.includes(child),
      closest: () => e.inert ? e : null,
      matches: () => e.disabled,
      getClientRects: () => e.hidden ? [] : [{}],
      getAttribute: (key: string) => attrs.get(key) ?? null,
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      removeAttribute: (key: string) => attrs.delete(key),
    };
    return e;
  }
  const opener = element('Add effect'), panel = element(), search = element(), main = element(), body = element(), other = element('Home');
  panel.children.push(search);
  active = opener;
  const doc = { get activeElement() { return active; }, body, querySelectorAll: () => [opener], querySelector: () => main };
  const start = () => beginEffectBrowserFocus(panel as unknown as HTMLElement, search as unknown as HTMLInputElement, doc as unknown as Document);
  return { opener, panel, search, main, body, other, doc, start };
}

describe('effect drawer focus lifecycle', () => {
  it('focuses search on opening and returns to the opener after closing', async () => {
    const s = scene(), close = s.start();
    expect(s.doc.activeElement).toBe(s.search);
    expect(s.search.select).toHaveBeenCalledOnce();
    s.panel.inert = true;
    close(); await Promise.resolve();
    expect(s.doc.activeElement).toBe(s.opener);
  });
  it('does not steal focus from another visible control when closing', async () => {
    const s = scene(), close = s.start();
    s.panel.inert = true; s.other.focus();
    close(); await Promise.resolve();
    expect(s.doc.activeElement).toBe(s.other);
    expect(s.opener.focus).not.toHaveBeenCalled();
  });
  it('waits for unmount then uses visible main when the original opener disappeared', async () => {
    const s = scene(), close = s.start();
    close();
    s.panel.isConnected = false; s.opener.isConnected = false; s.body.focus();
    await Promise.resolve();
    expect(s.doc.activeElement).toBe(s.main);
    expect(s.main.getAttribute('tabindex')).toBeNull();
  });
  it('does not return focus for an obsolete close after the drawer reopened', async () => {
    const s = scene(), close = s.start();
    s.panel.inert = true; close();
    s.panel.inert = false; s.start();
    await Promise.resolve();
    expect(s.doc.activeElement).toBe(s.search);
    expect(s.opener.focus).not.toHaveBeenCalled();
  });
});
