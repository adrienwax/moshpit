import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { conform, conformMaster, conformProxy } from '../src/conform/conform';
import { EngineService } from '../src/service/service';
import { newBlock, newProject } from '../src/project/build';
import type { ConformUpdate } from '../src/client';
import type { ProjectDoc, SourceId } from '../src/model';
import { MoshpitError } from '../src/errors';
import { FIX, SETTINGS } from './helpers';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3proxy-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('proxy-first conform stages', () => {
  it('the proxy stage is final in frames and keyframes; the master matches a one-shot conform byte for byte', async () => {
    const cache = path.join(dir, 'stages');
    const rec = await conformProxy('s1' as SourceId, FIX('src-c.mp4'), SETTINGS, cache);
    expect(rec.status).toBe('proxy');
    expect(rec.conformedHash).toBe('');
    expect(fs.existsSync(rec.proxy!.path)).toBe(true);
    expect(fs.existsSync(rec.path)).toBe(false); // planned, not written yet
    const { record } = await conformMaster(rec, FIX('src-c.mp4'), SETTINGS, cache);
    expect(record.status).toBe('ready');
    expect(record.id).toBe(rec.id);
    expect(record.path).toBe(rec.path);
    expect(record.frames).toBe(rec.frames);
    expect(record.keyframes).toEqual(rec.keyframes);
    expect(record.proxy!.conformedHash).toBe(rec.proxy!.conformedHash);
    // Order does not change bytes: the same as conforming in one go, fresh, elsewhere.
    const once = await conform('s2' as SourceId, FIX('src-c.mp4'), SETTINGS, path.join(dir, 'once'), undefined, { reuse: false });
    expect(record.conformedHash).toBe(once.record.conformedHash);
    expect(record.proxy!.conformedHash).toBe(once.record.proxy!.conformedHash);
  });

  it('reuses a cached proxy alone, and the whole conform once the master exists', async () => {
    const cache = path.join(dir, 'reuse');
    const rec = await conformProxy('r1' as SourceId, FIX('src-a.mp4'), SETTINGS, cache);
    const again = await conformProxy('r2' as SourceId, FIX('src-a.mp4'), SETTINGS, cache);
    expect(again.status).toBe('proxy');
    expect(again.notes).toContain('REUSED');
    await conformMaster(rec, FIX('src-a.mp4'), SETTINGS, cache);
    const third = await conformProxy('r3' as SourceId, FIX('src-a.mp4'), SETTINGS, cache);
    expect(third.status).toBe('ready');
    expect(third.notes).toContain('REUSED');
    expect(third.sourceId).toBe('r3');
  });
});

const project = (): ProjectDoc => newProject('pf', { working: { w: 640, h: 360 } });

/** Collect updates until `until` is seen for a source. */
function watch(svc: EngineService) {
  const seen: ConformUpdate[] = [];
  const off = svc.onConformUpdate((u) => seen.push(u));
  const until = (id: SourceId, state: ConformUpdate['state']) => new Promise<ConformUpdate>((res) => {
    const hit = seen.find((u) => u.sourceId === id && u.state === state);
    if (hit) return res(hit);
    const stop = svc.onConformUpdate((u) => { if (u.sourceId === id && u.state === state) { stop(); res(u); } });
  });
  return { seen, until, off };
}

describe('proxy-first import (EngineService)', () => {
  it('resolves at PROXY_READY, then MASTERING → READY with the ready record; a re-import is ready at once', async () => {
    const svc = new EngineService({ cacheDir: path.join(dir, 'svc1') });
    const doc = project();
    svc.updateProject(doc);
    const w = watch(svc);
    const r = await svc.importClip(FIX('src-b.mp4'));
    expect(r.conform.status).toBe('proxy');
    const id = r.source.id;
    expect(['PROXY_READY', 'MASTERING']).toContain(svc.conformStates().find((u) => u.sourceId === id)!.state);
    const ready = await w.until(id, 'READY');
    const states = w.seen.filter((u) => u.sourceId === id).map((u) => u.state);
    expect(states[0]).toBe('PROXY_READY');
    expect(states).toContain('MASTERING');
    expect(states.at(-1)).toBe('READY');
    expect(ready.conform!.status).toBe('ready');
    expect(ready.conform!.id).toBe(r.conform.id);
    expect(ready.conform!.conformedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ready.conform!.audio).toMatchObject({ sampleRate: 48000 }); // audio arrives with the master
    // Same clip again: the full conform is cached, so it is ready immediately, with no job.
    const again = await svc.importClip(FIX('src-b.mp4'));
    expect(again.conform.status).toBe('ready');
    expect(again.conform.notes).toContain('REUSED');
    expect(svc.conformStates().some((u) => u.sourceId === again.source.id)).toBe(false);
    w.off(); svc.dispose();
  });

  it('refuses a freeze while a timeline clip is still mastering (CONFORM_PENDING)', async () => {
    const svc = new EngineService({ cacheDir: path.join(dir, 'svc2') });
    const doc = project();
    svc.updateProject(doc);
    const w = watch(svc);
    const r = await svc.importClip(FIX('src-c.mp4'));
    doc.resources.sources.push(r.source); doc.resources.conforms.push(r.conform);
    const b = newBlock('picture', r.source.id, 0, 60);
    doc.timeline.blocks = [b];
    svc.updateProject(doc);
    const err = await svc.freeze({ kind: 'block', blockId: b.id }, [0, 10]).catch((e) => e);
    expect(err).toBeInstanceOf(MoshpitError);
    expect((err as MoshpitError).code).toBe('CONFORM_PENDING');
    await w.until(r.source.id, 'READY');
    w.off(); svc.dispose();
  });

  it('resumes a master when a project saved mid-conform is reopened', async () => {
    const cache = path.join(dir, 'svc3');
    // An import interrupted after its proxy: the project holds the proxy-stage record.
    const rec = await conformProxy('pending' as SourceId, FIX('src-a.mp4'), SETTINGS, path.join(cache, 'conform'));
    const doc = project();
    doc.resources.sources.push({ id: rec.sourceId, name: 'src-a.mp4', path: FIX('src-a.mp4'), sourceHash: rec.sourceHash, probe: { codec: 'h264', width: 640, height: 360, fps: { num: 30, den: 1 }, durationSec: 8, pixFmt: 'yuv420p', hasAlpha: false }, chapters: [], marks: [], conformId: rec.id, motionSignature: null });
    doc.resources.conforms.push(rec);
    const svc = new EngineService({ cacheDir: cache });
    const w = watch(svc);
    svc.updateProject(doc);
    const ready = await w.until(rec.sourceId, 'READY');
    expect(ready.conform!.status).toBe('ready');
    expect(fs.existsSync(ready.conform!.path)).toBe(true);
    w.off(); svc.dispose();
  });
});
