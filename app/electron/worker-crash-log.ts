import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** Bounded local diagnostics only: no project/media paths, payloads or upload. */
export function recordWorkerCrash(userData: string, event: { reason: string; exitCode: number; cause?: string; generation: number; version: string; time: string }): void {
  try {
    const dir = path.join(userData, 'diagnostics'), file = path.join(dir, 'worker-crashes.jsonl');
    mkdirSync(dir, { recursive: true });
    if (existsSync(file) && statSync(file).size >= 256 * 1024) {
      rmSync(`${file}.previous`, { force: true });
      renameSync(file, `${file}.previous`);
    }
    appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  } catch { /* A full or unavailable disk must never prevent engine recovery. */ }
}
