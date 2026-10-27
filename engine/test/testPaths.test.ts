import { expect, it, vi } from 'vitest';
import path from 'node:path';
const captured = vi.hoisted(() => ({ writes: vi.fn(), conform: vi.fn(async (_id: string, _file: string, _settings: unknown, cache: string) => ({ record: { path: path.join(cache, 'fake.mp4') }, video: {} })) }));
vi.mock('node:fs', () => ({ existsSync: () => false, writeFileSync: captured.writes }));
vi.mock('../src/conform/conform', () => ({ conform: captured.conform }));
vi.mock('../src/bitstream/mp4', () => ({ demux: vi.fn() }));
import { ARTIFACTS, CACHE, FIX, ROOT, conformed } from './helpers';

it('routes actual conform and sidecar destinations to managed E while keeping fixture reads in source', async () => {
  await conformed('example.mp4');
  expect(CACHE).toBe(path.join(process.env.EDENA_SCRATCH_TEMP!, 'test-cache'));
  expect(ARTIFACTS).toBe(process.env.EDENA_ARTIFACTS_DIR);
  expect(captured.conform.mock.calls[0][1]).toBe(FIX('example.mp4'));
  expect(captured.conform.mock.calls[0][3]).toBe(CACHE);
  expect(captured.writes.mock.calls[0][0]).toBe(path.join(CACHE, 'example.mp4.record.json'));
  expect(CACHE.startsWith(ROOT)).toBe(false);
});
