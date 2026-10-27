/** Display-only geometry, independent of media playback, project state or storage. */
export type ViewMode = 'fit' | 'fill' | 'custom';
export interface ViewTransform { mode: ViewMode; zoom: number; x: number; y: number }
export const DEFAULT_VIEW: ViewTransform = { mode: 'fit', zoom: 1, x: 0, y: 0 };
const dimension = (value: number) => Number.isFinite(value) ? Math.max(1, value) : 1;
const offset = (value: number) => Number.isFinite(value) ? value : 0;

export function viewerGeometry(w: number, h: number, imageW: number, imageH: number, view: ViewTransform) {
  const vw = dimension(w), vh = dimension(h), iw = dimension(imageW), ih = dimension(imageH);
  const fit = Math.min(vw / iw, vh / ih), fill = Math.max(vw / iw, vh / ih);
  const zoom = view.mode === 'fit' ? fit : view.mode === 'fill' ? fill : Math.max(.05, Math.min(8, Number.isFinite(view.zoom) ? view.zoom : 1));
  const width = Math.min(Number.MAX_VALUE, iw * zoom), height = Math.min(Number.MAX_VALUE, ih * zoom);
  const boundX = Math.max(0, (width - vw) / 2), boundY = Math.max(0, (height - vh) / 2);
  const x = boundX ? Math.max(-boundX, Math.min(boundX, offset(view.x))) : 0;
  const y = boundY ? Math.max(-boundY, Math.min(boundY, offset(view.y))) : 0;
  return { width, height, zoom, x, y };
}
