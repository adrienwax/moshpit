import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { CutStroke, readCutWires, type Point } from './wireCut';

const isCanvas = (target: EventTarget) => target instanceof Element
  && !target.closest('.react-flow__node, .react-flow__panel, .ctoolbar, .blockcue, button, input, select, textarea')
  && !!target.closest('.react-flow__pane, .react-flow__edge');

/** Right-click opens the menu; right-drag previews a cut, then commits all wires together. */
export function CanvasGestures({ children, edgeIds, revision, onMenu, onCut }: {
  children: ReactNode; edgeIds: string[]; revision: unknown;
  onMenu: (x: number, y: number) => void; onCut: (ids: string[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const active = useRef<{ pointer: number; stroke: CutStroke } | null>(null);
  const [preview, setPreview] = useState<{ points: Point[]; hits: string[] } | null>(null);

  function clear() {
    const gesture = active.current;
    active.current = null;
    if (gesture && root.current?.hasPointerCapture(gesture.pointer)) root.current.releasePointerCapture(gesture.pointer);
    setPreview(null);
  }
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (!active.current) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); clear(); }
      // A cut owns the canvas until release: do not delete nodes or open a container/menu mid-stroke.
      else { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', clear);
    window.addEventListener('resize', clear);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', clear);
      window.removeEventListener('resize', clear);
      const gesture = active.current;
      active.current = null;
      if (gesture && root.current?.hasPointerCapture(gesture.pointer)) root.current.releasePointerCapture(gesture.pointer);
    };
  }, []);
  // A remote edit, undo, or graph switch invalidates the path snapshot.
  useEffect(() => { if (active.current) clear(); }, [revision]);
  useEffect(() => {
    const marked: Element[] = [];
    root.current?.querySelectorAll('.react-flow__edge').forEach((el) => {
      if (preview?.hits.includes(el.getAttribute('data-id') ?? '')) { el.classList.add('cut-candidate'); marked.push(el); }
    });
    return () => marked.forEach((el) => el.classList.remove('cut-candidate'));
  }, [preview]);

  function move(e: PointerEvent<HTMLDivElement>) {
    const gesture = active.current;
    if (!gesture || gesture.pointer !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    if (!(e.buttons & 2)) { clear(); return; }
    gesture.stroke.move({ x: e.clientX, y: e.clientY });
    if (gesture.stroke.dragging) setPreview({ points: [...gesture.stroke.points], hits: [...gesture.stroke.hits] });
  }
  const bounds = preview ? root.current?.getBoundingClientRect() : null;
  return <div ref={root} className={'canvasgestures' + (preview ? ' cutting' : '')}
    onPointerDownCapture={(e) => {
      if (active.current) { e.preventDefault(); e.stopPropagation(); clear(); return; }
      if (e.button !== 2 || !isCanvas(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      active.current = { pointer: e.pointerId, stroke: new CutStroke({ x: e.clientX, y: e.clientY }, () => readCutWires(root.current!, new Set(edgeIds))) };
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onMouseDownCapture={(e) => { if (e.button === 2 && (active.current || isCanvas(e.target))) { e.preventDefault(); e.stopPropagation(); } }}
    onContextMenuCapture={(e) => { if (active.current || isCanvas(e.target) || e.target === root.current) { e.preventDefault(); e.stopPropagation(); } }}
    onWheelCapture={(e) => { if (active.current) { e.stopPropagation(); clear(); } }}
    onPointerMoveCapture={move}
    onPointerUpCapture={(e) => {
      const gesture = active.current;
      if (!gesture || gesture.pointer !== e.pointerId) return;
      e.preventDefault(); e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      gesture.stroke.move({ x: e.clientX, y: e.clientY });
      clear();
      if (e.button !== 2 || !inside) return;
      if (gesture.stroke.dragging) onCut([...gesture.stroke.hits]);
      else onMenu(gesture.stroke.origin.x, gesture.stroke.origin.y);
    }}
    onPointerCancel={clear} onLostPointerCapture={() => { if (active.current) clear(); }}>
    {children}
    {preview && bounds && <>
      <svg className="wirecut-stroke" viewBox={`0 0 ${bounds.width} ${bounds.height}`} preserveAspectRatio="none" aria-hidden="true"><polyline points={preview.points.map((p) => `${p.x - bounds.left},${p.y - bounds.top}`).join(' ')} /></svg>
      <div className="wirecut-hint" role="status">{preview.hits.length ? `Release to cut ${preview.hits.length} wire${preview.hits.length === 1 ? '' : 's'}` : 'Cross wires to cut'} · Esc cancels</div>
    </>}
  </div>;
}
