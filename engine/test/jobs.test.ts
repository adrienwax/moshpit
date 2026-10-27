// A-3: a job run over the port (as the app's utilityProcess runs it) writes the same bytes as one run
// in process; progress crosses, cancel crosses, and a dead host fails every call in flight.
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { localJobs, remoteJobs, serveJobs } from '../src/jobs/runner';
import { MoshpitError } from '../src/errors';
import type { SourceId } from '../src/model';
import { FIX, SETTINGS } from './helpers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3jobs-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A client and host joined by a real MessageChannel: every message is structured-cloned. */
function pair() {
  const { port1, port2 } = new MessageChannel();
  const host = serveJobs((m) => port2.postMessage(m));
  port2.on('message', host);
  const c = remoteJobs((m) => port1.postMessage(m));
  port1.on('message', c.receive);
  return { ...c, close: () => (port1.close(), port2.close()) };
}

describe('job runner over a port (A-3)', () => {
  it('conform proxy then master: identical hashes in process and over the port, with progress', async () => {
    const r = pair();
    try {
      const fracs: number[] = [];
      const remote = await r.runner.conformProxy('a' as SourceId, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'remote'), { onProgress: (f) => fracs.push(f) });
      const local = await localJobs.conformProxy('a' as SourceId, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'local'));
      expect(remote.proxy!.conformedHash).toBe(local.proxy!.conformedHash);
      expect(fracs.length).toBeGreaterThan(0);
      const rm = await r.runner.conformMaster(remote, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'remote'), true);
      const lm = await localJobs.conformMaster(local, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'local'), true);
      expect(rm.record.conformedHash).toBe(lm.record.conformedHash);
      expect(Object.keys(rm)).toEqual(['record']);
      expect(await r.runner.sourceHash(FIX('src-c.mp4'))).toBe(await localJobs.sourceHash(FIX('src-c.mp4')));
      expect(await r.runner.probe(FIX('src-c.mp4'))).toEqual(await localJobs.probe(FIX('src-c.mp4')));
    } finally { r.close(); }
  }, 60000);

  it('a cancel crosses the port and rejects as an AbortError', async () => {
    const r = pair();
    try {
      const ac = new AbortController();
      const p = r.runner.reconform('c' as SourceId, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'cancel'), { signal: ac.signal });
      setTimeout(() => ac.abort(), 50);
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    } finally { r.close(); }
  }, 60000);

  it('engine errors come back as MoshpitErrors with their code', async () => {
    const r = pair();
    try {
      const e = await r.runner.probe(path.join(dir, 'nope.mp4')).catch((x) => x);
      expect(e).toBeInstanceOf(MoshpitError);
      expect((e as MoshpitError).code).toBe((await localJobs.probe(path.join(dir, 'nope.mp4')).catch((x) => x)).code);
    } finally { r.close(); }
  });

  it('abortAll cancels every call in flight (a respawned worker drops the dead worker jobs)', async () => {
    const { port1, port2 } = new MessageChannel();
    const host = serveJobs((m) => port2.postMessage(m));
    port2.on('message', host);
    const c = remoteJobs((m) => port1.postMessage(m));
    port1.on('message', c.receive);
    try {
      const a = c.runner.reconform('x' as SourceId, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'abort-a'));
      const b = c.runner.reconform('y' as SourceId, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'abort-b'));
      await new Promise((r) => setTimeout(r, 100));
      host.abortAll();
      for (const p of [a, b]) await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    } finally { port1.close(); port2.close(); }
  }, 60000);

  it('a dead host fails every call in flight', async () => {
    const c = remoteJobs(() => {}); // the host never answers
    const a = c.runner.probe('x'), b = c.runner.sourceHash('y');
    c.fail(new MoshpitError('JOB_PROCESS_CRASHED'));
    for (const p of [a, b]) await expect(p).rejects.toMatchObject({ code: 'JOB_PROCESS_CRASHED' });
  });
});
