import type { ReactNode } from 'react';
import { SharedViewerViewport } from '../../../shared/ui/ViewerViewport';
import { DEFAULT_VIEW, type ViewTransform } from '../lib/viewer';
import { useSticky } from '../state/store';
import './viewer.css';

/** Moshpit owns persistence; the shared viewport only controls display geometry. */
export function ViewerViewport({ id, width, height, toolbar, children }: {
  id: string; width: number; height: number; toolbar?: ReactNode; children: ReactNode;
}) {
  const [value, onChange] = useSticky<ViewTransform>(`viewer.${id}`, DEFAULT_VIEW);
  return <SharedViewerViewport id={id} width={width} height={height} value={value} onChange={onChange} toolbar={toolbar}>{children}</SharedViewerViewport>;
}
