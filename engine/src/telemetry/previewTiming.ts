// Preview latency probe. Off unless MOSHPIT_PREVIEW_TIMING names a log file: then each line is
// console-logged and appended there as JSON, so request → draft/exact numbers can be captured.
import * as fs from 'node:fs';
import * as path from 'node:path';

let file = typeof process !== 'undefined' ? process.env.MOSHPIT_PREVIEW_TIMING : undefined;
// A stale/unwritable diagnostic destination must never prevent the worker loading.
try { if (file) fs.mkdirSync(path.dirname(file), { recursive: true }); }
catch { file = undefined; }

export const previewTimingOn = !!file;

export function previewTiming(line: Record<string, unknown>): void {
  if (!file) return;
  const json = JSON.stringify({ at: Date.now(), ...line });
  console.log('[preview-timing]', json);
  try { fs.appendFileSync(file, json + '\n'); } catch { /* the probe never breaks a render */ }
}
