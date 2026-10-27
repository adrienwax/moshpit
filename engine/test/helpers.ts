import * as fs from 'node:fs';
import * as path from 'node:path';
import { conform, type ConformSettings } from '../src/conform/conform';
import { demux, type Mp4Video } from '../src/bitstream/mp4';
import type { ConformedSource, SourceId } from '../src/model';

export const ROOT = path.resolve(__dirname, '..', '..');
export const FIX = (n: string) => path.join(ROOT, 'fixtures', n);
if (process.env.EDENA_SCRATCH_MANAGED !== '1' || !process.env.EDENA_SCRATCH_TEMP || !process.env.EDENA_ARTIFACTS_DIR) throw new Error('Use the managed npm test launcher for E-drive test caches.');
export const CACHE = path.join(process.env.EDENA_SCRATCH_TEMP, 'test-cache');
export const ARTIFACTS = process.env.EDENA_ARTIFACTS_DIR;
export const SETTINGS: ConformSettings = { fps: { num: 30, den: 1 }, width: 640, height: 360, proxyDivisor: 4, crf: 18 };

/** Conform once per managed run; workers reuse its record without writing in the checkout. */
export async function conformed(name: string): Promise<{ record: ConformedSource; video: Mp4Video }> {
  const side = path.join(CACHE, `${name}.record.json`);
  if (fs.existsSync(side)) {
    // Another worker may be mid-write: an unreadable sidecar just means conform again (it is atomic).
    try {
      const record = JSON.parse(fs.readFileSync(side, 'utf8')) as ConformedSource;
      if (fs.existsSync(record.path)) return { record, video: demux(record.path) };
    } catch { /* fall through */ }
  }
  const r = await conform(`src-${name}` as SourceId, FIX(name), SETTINGS, CACHE);
  fs.writeFileSync(side, JSON.stringify(r.record, null, 2));
  return r;
}
