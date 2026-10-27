import { useEffect, useRef, type HTMLAttributes } from 'react';
import './shell.css';

type Orientation = 'vertical' | 'horizontal';
type Delta = readonly [dx: number, dy: number];
/** Separator orientation is the divider's direction, not the drag direction. */
export function resizeKeyDelta(key: string, orientation: Orientation, fine = false): Delta | null {
  const amount = fine ? 1 : 10;
  if (orientation === 'vertical') return key === 'ArrowLeft' ? [-amount, 0] : key === 'ArrowRight' ? [amount, 0] : null;
  return key === 'ArrowUp' ? [0, -amount] : key === 'ArrowDown' ? [0, amount] : null;
}

export interface SharedResizeHandleProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture' | 'onKeyDown'> {
  orientation: Orientation;
  label: string;
  /** Snapshot the application's sizing state once per pointer/keyboard gesture. */
  onResizeStart: (element: HTMLDivElement) => (dx: number, dy: number) => void;
}

export function SharedResizeHandle({ orientation, label, className, onResizeStart, title, ...rest }: SharedResizeHandleProps) {
  const drag = useRef<{ element: HTMLDivElement; id: number; x: number; y: number; move: (dx: number, dy: number) => void } | null>(null);
  const finish = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    current.element.classList.remove('drag');
    if (current.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id);
  };
  useEffect(() => finish, []);
  return <div {...rest} className={[className, 'es-resize'].filter(Boolean).join(' ')} role="separator" tabIndex={rest.tabIndex ?? 0}
    aria-label={label} aria-orientation={orientation} title={title ?? label}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault();
      const element = event.currentTarget;
      const move = onResizeStart(element);
      element.setPointerCapture(event.pointerId);
      element.classList.add('drag');
      drag.current = { element, id: event.pointerId, x: event.clientX, y: event.clientY, move };
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (current?.id === event.pointerId) current.move(event.clientX - current.x, event.clientY - current.y);
    }}
    onPointerUp={event => { if (drag.current?.id === event.pointerId) finish(); }}
    onPointerCancel={event => { if (drag.current?.id === event.pointerId) finish(); }}
    onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) finish(); }}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || drag.current) return;
      const delta = resizeKeyDelta(event.key, orientation, event.shiftKey);
      if (!delta) return;
      event.preventDefault(); event.stopPropagation();
      onResizeStart(event.currentTarget)(...delta);
    }}
  />;
}
