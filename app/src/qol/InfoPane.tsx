import { useEffect, useState } from 'react';
import { createStore, useStore } from '../state/store';
import './info-pane.css';

const idle = { label: 'Info', text: 'Hover or focus a control to learn what it does.' };
const help = createStore(idle);
const tipId = 'moshpit-tip';

/** One help source for existing titles, explicit help, and accessible control names. */
export function HelpTracking() {
  useEffect(() => {
    let current: Element | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlink = () => {
      clearTimeout(timer);
      if (current) {
        const ids = (current.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== tipId);
        if (ids.length) current.setAttribute('aria-describedby', ids.join(' '));
        else current.removeAttribute('aria-describedby');
      }
      current = null;
    };
    const update = (target: EventTarget | null, delay: number) => {
      if (!(target instanceof Element) || target.closest('.info-pane')) return;
      const el = target.closest('[title], [data-tip], [aria-description], button, summary, input, select, textarea, [role="slider"], [role="tab"]');
      if (!el) { unlink(); return; }
      const title = el.getAttribute('title');
      if (title !== null) {
        el.setAttribute('data-tip', title);
        el.removeAttribute('title');
      }
      const label = el.getAttribute('data-help-label') || el.getAttribute('aria-label') ||
        (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.labels?.[0]?.textContent : el.textContent)?.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Info';
      const text = el.getAttribute('data-tip') || el.getAttribute('aria-description') || label;
      // Repeated movement inside the same control must not delay or erase its help.
      if (el === current && help.get().text === text) return;
      unlink();
      current = el;
      timer = setTimeout(() => {
        if (current !== el || !el.isConnected) return;
        help.set({ label, text });
        const ids = new Set((el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
        ids.add(tipId);
        el.setAttribute('aria-describedby', [...ids].join(' '));
      }, delay);
    };
    const over = (e: MouseEvent) => update(e.target, 100);
    const focus = (e: FocusEvent) => update(e.target, 0);
    const leave = (e: MouseEvent) => { if (!e.relatedTarget) unlink(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') unlink(); };
    document.addEventListener('mouseover', over);
    document.addEventListener('focusin', focus);
    document.addEventListener('mouseout', leave);
    window.addEventListener('blur', unlink);
    window.addEventListener('keydown', escape);
    return () => {
      unlink();
      document.removeEventListener('mouseover', over);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('mouseout', leave);
      window.removeEventListener('blur', unlink);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  return null;
}

/** Fixed dock: help never shifts the viewer and stays available to read or copy. */
export function InfoPane() {
  const info = useStore(help, s => s);
  const [collapsed, setCollapsed] = useState(false);
  return <section className={'info-pane' + (collapsed ? ' collapsed' : '')} aria-label="Info">
    <header><span>ⓘ INFO</span><button type="button" aria-label={collapsed ? 'Show Info pane' : 'Collapse Info pane'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '▸' : '▾'}</button></header>
    <div className="info-content" id={tipId} tabIndex={collapsed ? -1 : 0}>
      <strong>{info.label}</strong>
      {info.text !== info.label && <p>{info.text}</p>}
    </div>
  </section>;
}
