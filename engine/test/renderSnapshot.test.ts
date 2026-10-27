// Service/queue contract tests. Encoding and GPU rendering are stubbed; conform completion is
// controlled explicitly so edits and project switches happen inside the actual master wait.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConformedSource, ProjectDoc, SourceId } from '../src/model';
import { EngineService } from '../src/service/service';
import { localJobs } from '../src/jobs/runner';
import { newBlock, newProject } from '../src/project/build';
import { compileProject } from '../src/runtime/session';
import { exportRange } from '../src/runtime/export';
import type { RenderJob } from '../src/client';

vi.mock('../src/runtime/session', () => ({
  compileProject: vi.fn((doc: ProjectDoc) => ({ plan: { frames: doc.timeline.blocks[0].out }, close: vi.fn() })),
  engineOptions: vi.fn(() => ({})),
}));
vi.mock('../src/runtime/engine', () => ({ Engine: class { attachFreeze() {} dispose() {} } }));
vi.mock('../src/runtime/export', async (original) => ({
  ...await original<typeof import('../src/runtime/export')>(),
  exportRange: vi.fn(async (_engine, _doc, plan, _config, file) => ({ file, frames: plan.frames, ms: 1 })),
}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-render-snapshot-'));
const services: EngineService[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => { for (const svc of services.splice(0)) svc.dispose(); });
// Remove only this test's generated temporary directory.
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function project(name: string, status: 'proxy' | 'ready' = 'proxy'): ProjectDoc {
  const doc = newProject(name);
  const sourceId = `source-${name}` as SourceId;
  const rec = {
    id: `conform-${name}`, sourceId, sourceHash: name, status,
    path: path.join(dir, `${name}-master.mp4`), fps: { num: 30, den: 1 },
    width: 640, height: 360, frames: 60, conformedHash: status === 'ready' ? 'finished' : '',
    proxy: { path: path.join(dir, `${name}-proxy.mp4`), width: 160, height: 90, conformedHash: 'proxy' },
  } as ConformedSource;
  doc.resources.conforms = [rec];
  doc.resources.sources = [{
    id: sourceId, name, path: path.join(dir, `${name}-source.mp4`), sourceHash: name,
    probe: { codec: 'h264', width: 640, height: 360, fps: rec.fps, durationSec: 2, pixFmt: 'yuv420p', hasAlpha: false },
    chapters: [], marks: [], conformId: rec.id, motionSignature: null,
  }];
  doc.timeline.blocks = [newBlock('picture', sourceId, 0, 30)];
  return doc;
}

function setup() {
  const pending = new Map<SourceId, { finish(): void; fail(): void }>();
  const conformMaster = vi.fn<typeof localJobs.conformMaster>((rec) => new Promise((resolve, reject) => {
    pending.set(rec.sourceId, {
      finish: () => resolve({ record: { ...rec, status: 'ready', conformedHash: 'finished' } }),
      fail: () => reject(new Error('conform stopped')),
    });
  }));
  const svc = new EngineService({ cacheDir: dir, jobs: { ...localJobs, conformMaster } });
  services.push(svc);
  const job = (doc?: ProjectDoc): RenderJob => ({
    id: 'export', name: 'export', outPath: path.join(dir, 'export.mp4'),
    config: { format: 'mp4-h264', width: 640, height: 360, audio: false }, ...(doc ? { doc } : {}),
  });
  return { svc, pending, conformMaster, job };
}

describe('render pins the submitted project through conform waits', () => {
  it('a legacy caller renders the original timeline after edits during the wait', async () => {
    const { svc, pending, job } = setup();
    const doc = project('edited');
    svc.updateProject(doc);
    const progress = vi.fn();
    const rendering = svc.render(job(), progress);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ conform: { fraction: 0, clips: 1 } }));
    // Even mutation by a direct caller cannot change the in-flight snapshot.
    doc.timeline.blocks[0].out = 60;
    svc.updateProject(doc);
    pending.get(doc.resources.sources[0].id)!.finish();
    await rendering;
    const rendered = vi.mocked(exportRange).mock.calls[0][1];
    expect(rendered.timeline.blocks[0].out).toBe(30);
    expect(rendered.resources.conforms[0]).toMatchObject({ status: 'ready', conformedHash: 'finished' });
    expect(doc.resources.conforms[0].status).toBe('proxy');
    expect((svc as unknown as { doc: ProjectDoc }).doc).toBe(doc);
  });

  it('switching projects during the wait neither exports nor overwrites the new live project', async () => {
    const { svc, pending, job } = setup();
    const original = project('old');
    const current = project('new', 'ready');
    svc.updateProject(original);
    const rendering = svc.render(job(), () => {});
    svc.updateProject(current);
    pending.get(original.resources.sources[0].id)!.finish();
    await rendering;
    expect(vi.mocked(compileProject).mock.calls[0][0].id).toBe(original.id);
    expect(vi.mocked(exportRange).mock.calls[0][1].id).toBe(original.id);
    expect((svc as unknown as { doc: ProjectDoc }).doc).toBe(current);
  });

  it('a supplied snapshot resumes its own conform without being installed as the live document', async () => {
    const { svc, pending, conformMaster, job } = setup();
    const submitted = project('submitted');
    const current = project('current', 'ready');
    svc.updateProject(current);
    const rendering = svc.render(job(submitted), () => {});
    expect(conformMaster.mock.calls[0][0].id).toBe(submitted.resources.conforms[0].id);
    submitted.timeline.blocks[0].out = 50;
    pending.get(submitted.resources.sources[0].id)!.finish();
    await rendering;
    const rendered = vi.mocked(exportRange).mock.calls[0][1];
    expect(rendered.id).toBe(submitted.id);
    expect(rendered.timeline.blocks[0].out).toBe(30);
    expect(rendered.resources.conforms[0].status).toBe('ready');
    expect((svc as unknown as { doc: ProjectDoc }).doc).toBe(current);
  });

  it('a supplied ready snapshot needs no currently loaded project', async () => {
    const { svc, job } = setup();
    const submitted = project('standalone', 'ready');
    await svc.render(job(submitted), () => {});
    expect(vi.mocked(exportRange).mock.calls[0][1].id).toBe(submitted.id);
    expect((svc as unknown as { doc: ProjectDoc | null }).doc).toBeNull();
  });

  it.each(['snapshot', 'current'] as const)('protects the %s source before waiting', async (owner) => {
    const { svc, conformMaster, job } = setup();
    const submitted = project('protected-submitted');
    const current = project('protected-current', 'ready');
    svc.updateProject(current);
    const request = job(submitted);
    request.outPath = (owner === 'snapshot' ? submitted : current).resources.sources[0].path;
    await expect(svc.render(request, () => {})).rejects.toMatchObject({ code: 'SOURCE_PROTECTED' });
    expect(conformMaster).not.toHaveBeenCalled();
    expect(exportRange).not.toHaveBeenCalled();
  });

  it('rechecks source protection against the live project after the conform wait', async () => {
    const { svc, pending, job } = setup();
    const submitted = project('protected-wait');
    svc.updateProject(submitted);
    const request = job();
    const rendering = svc.render(request, () => {});
    const current = project('new-protected', 'ready');
    current.resources.sources[0].path = request.outPath;
    svc.updateProject(current);
    pending.get(submitted.resources.sources[0].id)!.finish();
    await expect(rendering).rejects.toMatchObject({ code: 'SOURCE_PROTECTED' });
    expect(compileProject).not.toHaveBeenCalled();
  });

  it('a failed master rejects without compiling or exporting a proxy', async () => {
    const { svc, pending, job } = setup();
    const submitted = project('failed');
    const rendering = svc.render(job(submitted), () => {});
    pending.get(submitted.resources.sources[0].id)!.fail();
    await expect(rendering).rejects.toMatchObject({ code: 'CONFORM_FAILED' });
    expect(compileProject).not.toHaveBeenCalled();
  });

  it('an already-cancelled export never starts its snapshot master', async () => {
    const { svc, conformMaster, job } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(svc.render(job(project('cancelled')), () => {}, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(conformMaster).not.toHaveBeenCalled();
    expect(compileProject).not.toHaveBeenCalled();
  });

  it('cancelling a wait keeps the reusable master running and never starts the export', async () => {
    const { svc, pending, job } = setup();
    const submitted = project('cancel-wait');
    const ac = new AbortController();
    const rendering = svc.render(job(submitted), () => {}, ac.signal);
    ac.abort();
    await expect(rendering).rejects.toMatchObject({ name: 'AbortError' });
    expect(compileProject).not.toHaveBeenCalled();
    pending.get(submitted.resources.sources[0].id)!.finish();
    await svc.awaitTimelineMasters(() => {}, undefined, submitted);
    expect(svc.conformStates()[0].state).toBe('READY');
  });
});
