// Proxy-first import, per clip: "usable now · finalizing" while the master encodes in the
// background, a quiet done state when it lands, and a warning if it failed (the proxy still works).
import type { SourceId } from '@moshpit/engine';
import { mastersPending, useProject } from '../state/project';
import { useMaster } from '../state/conforms';
import { asError } from '../qol/qol';

export function ConformBadge({ sourceId }: { sourceId?: SourceId }) {
  const m = useMaster(sourceId);
  const pending = useProject((d) => !!sourceId && mastersPending(d, [sourceId]).length > 0);
  if (!sourceId) return null;
  if (m?.state === 'FAILED') {
    return <span className="cbadge fail" title={`The full-quality conform failed: ${m.error ? asError(m.error).humanMessage : 'see the error toast'}. The proxy still plays and moshes; export and exact preview need the master — re-import to retry.`}>⚠ proxy only</span>;
  }
  if (pending) {
    const pct = m?.state === 'MASTERING' && m.fraction != null ? ` ${Math.round(m.fraction * 100)}%` : '';
    return <span className="cbadge pend" title="Usable now on its proxy: browse, slice and mosh it. The full-quality master is encoding in the background; exact preview, freeze and export wait for it (an export queues itself).">◐ usable now · finalizing{pct}</span>;
  }
  if (m?.state === 'READY') return <span className="cbadge done" title="The full-quality master is ready: exact preview, freeze and export use it">✓ full quality</span>;
  return null;
}
