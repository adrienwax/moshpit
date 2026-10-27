import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_VIEW, viewerGeometry, type ViewTransform } from './viewer';
import './viewer.css';

/** Display transform only: neither Fill nor zoom changes project pixels or export framing.
 * Children are never played or paused. Native media controls and interactive descendants
 * keep their pointer events; custom controls may opt out with data-viewer-no-pan.
 */
export interface SharedViewerViewportProps {
  id: string; width: number; height: number; value: ViewTransform; onChange: (next: ViewTransform) => void; toolbar?: ReactNode; children: ReactNode; className?: string;
}

export function SharedViewerViewport({ id, width, height, value: view, onChange: setView, toolbar, children, className = '' }: SharedViewerViewportProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const drag = useRef<{ pointer: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const geometry = viewerGeometry(size.w, size.h, width, height, view);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  const zoom = (value: number) => setView({ mode: 'custom', zoom: Math.max(.05, Math.min(8, value)), x: geometry.x, y: geometry.y });
  const wheelZoom = useRef<(event: WheelEvent) => void>(() => {});
  wheelZoom.current = event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(geometry.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  };
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const wheel = (event: WheelEvent) => wheelZoom.current(event);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const fit = () => setView({ ...DEFAULT_VIEW });
  const isControl = (target: EventTarget | null) => target instanceof Element && !!target.closest('button, input, select, textarea, a, [role="slider"], [role="button"], [contenteditable="true"], video[controls], audio[controls], [data-viewer-no-pan]');
  return <div className={`es-viewer ${className}`.trim()} data-viewer-id={id}>
    <div className="es-viewer-toolbar" role="toolbar" aria-label="Viewer controls">
      {toolbar}
      <div className="es-viewer-scale" role="group" aria-label="Viewer magnification">
        <button type="button" aria-pressed={view.mode === 'fit'} onClick={fit} title="Show the entire image">Fit</button>
        <button type="button" aria-pressed={view.mode === 'fill'} onClick={() => setView({ ...DEFAULT_VIEW, mode: 'fill' })} title="Fill the viewer; crops the view only">Fill</button>
        <button type="button" aria-pressed={view.mode === 'custom' && view.zoom === 1} onClick={() => setView({ ...DEFAULT_VIEW, mode: 'custom' })} title="One source pixel per screen CSS pixel">100%</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoom(geometry.zoom / 1.25)}>−</button>
        <span className="es-viewer-percent" title="View magnification">{Math.round(geometry.zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoom(geometry.zoom * 1.25)}>+</button>
      </div>
    </div>
    <div ref={ref} className="es-viewer-window" aria-label="Picture viewport" title="Drag to pan · Ctrl+wheel to zoom · double-click to fit"
      onDoubleClick={e => { if (!isControl(e.target)) fit(); }}
      onPointerDown={e => {
        if (e.button !== 0 || isControl(e.target)) return;
        drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, startX: geometry.x, startY: geometry.y };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const d = drag.current; if (!d || d.pointer !== e.pointerId) return;
        setView({ mode: 'custom', zoom: geometry.zoom, x: d.startX + e.clientX - d.x, y: d.startY + e.clientY - d.y });
      }}
      onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <div className="es-viewer-picture" style={{ width: geometry.width, height: geometry.height, transform: `translate(-50%, -50%) translate(${geometry.x}px, ${geometry.y}px)` }}>{children}</div>
    </div>
  </div>;
}
