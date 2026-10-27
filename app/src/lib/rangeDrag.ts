/** A cancellable pointer gesture. Updates use the initial pointer position, never the moving range. */
export function rangeDrag(options: {
  target: HTMLElement; pointerId: number; startX: number;
  current: () => boolean; move: (deltaX: number) => void; restore: () => void; end: (cancelled: boolean) => void;
}): () => void {
  const { target, pointerId, startX, current, move, restore, end } = options;
  const doc = target.ownerDocument;
  let finished = false;
  const finish = (cancel: boolean) => {
    if (finished) return;
    finished = true;
    target.removeEventListener('pointermove', moving);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', cancelled);
    target.removeEventListener('lostpointercapture', cancelled);
    doc.removeEventListener('keydown', key, true);
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    if (cancel && current()) restore();
    end(cancel);
  };
  const moving = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (!current()) return finish(true);
    move(event.clientX - startX);
  };
  const up = (event: PointerEvent) => { if (event.pointerId === pointerId) { moving(event); finish(false); } };
  const cancelled = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(true); };
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); finish(true);
  };
  target.setPointerCapture(pointerId);
  target.addEventListener('pointermove', moving);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', cancelled);
  target.addEventListener('lostpointercapture', cancelled);
  doc.addEventListener('keydown', key, true);
  return () => finish(true);
}
