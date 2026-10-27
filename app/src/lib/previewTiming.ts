// Preview latency probe, UI side: Program request → draft drawn, request → exact drawn, and
// playback drops. Kept in a bounded buffer on window; console-logged once a probe sets `log`.
// The worker writes its half (queue wait, render, replay) to MOSHPIT_PREVIEW_TIMING.
//   window.__moshpitPreviewTiming = { log: true, lines: [] }  …interact…  read .lines

type Probe = { log: boolean; lines: Record<string, unknown>[] };
const probe: Probe = { log: false, lines: [] };
if (typeof window !== 'undefined') Object.assign(window, { __moshpitPreviewTiming: probe });

export function previewTiming(line: Record<string, unknown>): void {
  const row = { at: Math.round(performance.now()), ...line };
  probe.lines.push(row);
  if (probe.lines.length > 2000) probe.lines.shift();
  if (probe.log) console.log('[preview-timing]', JSON.stringify(row));
}
