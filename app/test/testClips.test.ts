import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('uses the desktop test-clips override in the renderer without exposing process.env', async () => {
  vi.resetModules();
  vi.stubGlobal('window', { moshpitHost: { testClipsDir: 'C:/portable/calm-test-footage' } });
  expect((await import('../src/lib/testClips')).TEST_CLIPS_DIR).toBe('C:/portable/calm-test-footage');
});

it('honours an empty override as disabled instead of falling back to the developer folder', async () => {
  vi.resetModules();
  vi.stubGlobal('window', { moshpitHost: { testClipsDir: '' } });
  expect((await import('../src/lib/testClips')).TEST_CLIPS_DIR).toBe('');
});

it('remains importable by the worker without a browser window', async () => {
  vi.resetModules();
  vi.stubGlobal('window', undefined);
  expect((await import('../src/lib/testClips')).TEST_CLIPS_DIR).toBe('');
});
