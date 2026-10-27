import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { recordWorkerCrash } from '../electron/worker-crash-log';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'mp-crash-log-')); dirs.push(dir); return dir; };
const event = { reason: 'crashed', exitCode: 133, cause: 'gpu-context-lost', generation: 2, version: 'test', time: '2026-10-11T14:00:00Z' };
it('retains crash identity and rotates one bounded prior log', () => {
  const dir = root(), logs = path.join(dir, 'diagnostics'), file = path.join(logs, 'worker-crashes.jsonl');
  recordWorkerCrash(dir, event);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(event);
  const old = 'x'.repeat(256 * 1024); writeFileSync(file, old);
  recordWorkerCrash(dir, { ...event, generation: 3 });
  expect(readFileSync(`${file}.previous`, 'utf8')).toBe(old);
  expect(JSON.parse(readFileSync(file, 'utf8')).generation).toBe(3);
  writeFileSync(file, old + 'new'); recordWorkerCrash(dir, event);
  expect(readFileSync(`${file}.previous`, 'utf8')).toBe(old + 'new');
});
it('never prevents recovery when the diagnostic destination is unavailable', () => {
  const dir = root(); writeFileSync(path.join(dir, 'diagnostics'), 'a file blocks this directory');
  expect(() => recordWorkerCrash(dir, event)).not.toThrow();
});
