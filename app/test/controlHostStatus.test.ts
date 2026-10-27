import { describe, expect, it } from 'vitest';
import { CONTROL_HOST_LABELS, observeControlHostStatus, parseControlHostStatus, trackControlHostStartup, type ControlHostStatus } from '../control-status';
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe('CT host status truth', () => {
  it('reports disabled when the optional host returns null', async () => {
    const seen: ControlHostStatus[] = [];
    expect(await trackControlHostStartup(async () => null, s => seen.push(s))).toBeNull();
    expect(seen).toEqual(['starting', 'disabled']);
    expect(CONTROL_HOST_LABELS[seen.at(-1)!].ready).toBe(false);
  });
  it('never reports listening until actual host startup resolves', async () => {
    let ready!: (value: object) => void;
    const pending = new Promise<object>(resolve => { ready = resolve; });
    const seen: ControlHostStatus[] = [];
    const result = trackControlHostStartup(() => pending, s => seen.push(s));
    expect(seen).toEqual(['starting']);
    ready({}); await result;
    expect(seen).toEqual(['starting', 'listening']);
    expect(CONTROL_HOST_LABELS.listening.detail).toContain('device status unknown');
  });
  it('reports startup failure as unavailable while preserving the error', async () => {
    const failure = new Error('listen failed'), seen: ControlHostStatus[] = [];
    await expect(trackControlHostStartup(async () => { throw failure; }, s => seen.push(s))).rejects.toBe(failure);
    expect(seen).toEqual(['starting', 'unavailable']);
  });
  it('does not equate preload bridge presence with readiness', async () => {
    const seen: ControlHostStatus[] = [];
    observeControlHostStatus({}, s => seen.push(s)); await tick();
    expect(seen).toEqual(['unknown']);
    expect(CONTROL_HOST_LABELS.unknown.ready).toBe(false);
  });
  it('reads a disabled host through the bridge', async () => {
    const seen: ControlHostStatus[] = [];
    observeControlHostStatus({ hostStatus: async () => 'disabled' }, s => seen.push(s)); await tick();
    expect(seen).toEqual(['unknown', 'disabled']);
  });
  it('keeps a new event over a delayed stale startup snapshot', async () => {
    let receive!: (s: unknown) => void, resolve!: (s: unknown) => void;
    const pending = new Promise<unknown>(r => { resolve = r; });
    const seen: ControlHostStatus[] = [];
    observeControlHostStatus({ hostStatus: () => pending, onHostStatus: fn => { receive = fn; return () => {}; } }, s => seen.push(s));
    await tick(); receive('listening'); resolve('starting'); await tick();
    expect(seen).toEqual(['unknown', 'listening']);
  });
  it('keeps rejected or malformed reads unknown, browser unavailable', async () => {
    const absent: ControlHostStatus[] = [], failed: ControlHostStatus[] = [];
    observeControlHostStatus(undefined, s => absent.push(s));
    observeControlHostStatus({ hostStatus: async () => { throw Error('no handler'); } }, s => failed.push(s)); await tick();
    expect(absent).toEqual(['unavailable']); expect(failed.at(-1)).toBe('unknown');
    expect(parseControlHostStatus('connected')).toBe('unknown');
    expect(parseControlHostStatus(true)).toBe('unknown');
  });
  it('unsubscribes and ignores late replies after disposal', async () => {
    let receive!: (s: unknown) => void, resolve!: (s: unknown) => void, removed = false;
    const pending = new Promise<unknown>(r => { resolve = r; });
    const seen: ControlHostStatus[] = [];
    const dispose = observeControlHostStatus({ hostStatus: () => pending, onHostStatus: fn => { receive = fn; return () => { removed = true; }; } }, s => seen.push(s));
    await tick(); dispose(); receive('listening'); resolve('disabled'); await tick();
    expect(removed).toBe(true); expect(seen).toEqual(['unknown']);
  });
});
