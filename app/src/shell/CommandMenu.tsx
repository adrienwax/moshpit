import { useEffect, useRef, type ReactNode } from 'react';

/** Native disclosure + ordinary buttons: Tab navigation, without a partial ARIA menubar. */
export function CommandMenu({ label, children, onOpen }: { label: string; children: ReactNode; onOpen?: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details className="command-menu" name="app-commands" ref={ref}
    onToggle={event => { if (event.currentTarget.open) onOpen?.(); }}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false; }}
    onKeyDown={event => {
      if (event.key === 'Escape' && event.currentTarget.open) {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }}
    onClick={event => {
      if ((event.target as Element).closest('button[data-command]')) {
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }}>
    <summary>{label}</summary>
    <div className="command-panel" aria-label={label + ' commands'}>{children}</div>
  </details>;
}
