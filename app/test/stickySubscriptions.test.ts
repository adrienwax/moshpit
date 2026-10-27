import { afterEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ readers: [] as { get: () => unknown; changed: ReturnType<typeof vi.fn>; unsubscribe: () => void }[], effects: [] as (() => void)[] }));
vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void) => { hooks.effects.push(fn); },
  useSyncExternalStore: (subscribe: (fn: () => void) => () => void, get: () => unknown) => {
    const changed = vi.fn();
    hooks.readers.push({ get, changed, unsubscribe: subscribe(changed) });
    return get();
  },
}));
import { readSticky, useSticky, useStickyValue } from '../src/state/store';
afterEach(() => { hooks.readers.forEach(reader => reader.unsubscribe()); hooks.readers.length = 0; hooks.effects.length = 0; });

describe('cross-component sticky subscriptions', () => {
  it('notifies range scopes when the arrangement changes its own zoom', () => {
    const key = 'test:arrangement-zoom';
    const initial = { start: 0, len: 100, of: 100 };
    const [, setZoom] = useSticky(key, initial);
    expect(useStickyValue(key)).toBe(initial);
    const next = { start: 50, len: 10, of: 100 };
    setZoom(next);
    expect(hooks.readers[1].changed).toHaveBeenCalledOnce();
    expect(hooks.readers[1].get()).toBe(next);
    expect(readSticky(key)).toBe(next);
  });
  it('does not install an undefined default when a reader mounts before its owner', () => {
    const key = 'test:late-owner';
    expect(useStickyValue(key)).toBeUndefined();
    const [value] = useSticky(key, 42);
    hooks.effects.forEach(effect => effect());
    expect(value).toBe(42);
    expect(hooks.readers[0].changed).toHaveBeenCalledOnce();
    expect(hooks.readers[0].get()).toBe(42);
  });
  it('keeps functional updates and isolates unrelated keys', () => {
    const [, setCount] = useSticky('test:count', 1);
    useStickyValue('test:unrelated');
    setCount(n => n + 1); setCount(n => n + 1);
    expect(readSticky('test:count')).toBe(3);
    expect(hooks.readers[0].changed).toHaveBeenCalledTimes(2);
    expect(hooks.readers[1].changed).not.toHaveBeenCalled();
  });
  it('removes unmounted subscribers and suppresses unchanged values', () => {
    const [, setValue] = useSticky('test:unsubscribe', 1);
    setValue(1);
    expect(hooks.readers[0].changed).not.toHaveBeenCalled();
    hooks.readers[0].unsubscribe(); setValue(2);
    expect(hooks.readers[0].changed).not.toHaveBeenCalled();
  });
});
