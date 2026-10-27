import { useCallback, useEffect, useSyncExternalStore } from 'react';

// A tiny external store. State lives outside React (L24); components read slices through
// useStore and must select stable references (a fresh object per call re-renders forever).
export interface Store<T> {
  get(): T;
  set(next: T | ((s: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const v = typeof next === 'function' ? (next as (s: T) => T)(state) : next;
      if (v === state) return;
      state = v;
      listeners.forEach((l) => l());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useStore<T, U>(store: Store<T>, select: (s: T) => U): U {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/**
 * Audit B7: useState that survives the component unmounting — a workspace switch must not reset
 * a search box, a filter, a zoom or a half-typed field. Session-only (not saved to disk); `key`
 * names the value app-wide, so give per-item state a per-item key.
 */
const sticky = new Map<string, unknown>();
const stickyListeners = new Map<string, Set<() => void>>();
/** Read a sticky value outside React (e.g. the arrangement's zoom window for Preview selection). */
export const readSticky = <T,>(key: string): T | undefined => sticky.get(key) as T | undefined;
/** Update shared session UI state from a deliberate action outside its owning component. */
export function writeSticky<T>(key: string, value: T) {
  if (Object.is(sticky.get(key), value)) return;
  sticky.set(key, value);
  stickyListeners.get(key)?.forEach(listener => listener());
}
/** Observe another component's sticky value without claiming its initial/default value. */
export function useStickyValue<T>(key: string): T | undefined {
  const subscribe = useCallback((listener: () => void) => {
    let listeners = stickyListeners.get(key);
    if (!listeners) stickyListeners.set(key, listeners = new Set());
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) stickyListeners.delete(key); };
  }, [key]);
  return useSyncExternalStore(subscribe, () => readSticky<T>(key));
}
export function useSticky<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  // Stored on first read, so the value keeps one identity until it is set.
  if (!sticky.has(key)) sticky.set(key, initial);
  const value = useStickyValue<T>(key) as T;
  // A read-only observer may already be mounted when this owner supplies the initial value.
  useEffect(() => { stickyListeners.get(key)?.forEach(listener => listener()); }, [key]);
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      const prev = sticky.get(key) as T;
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      if (Object.is(prev, next)) return;
      sticky.set(key, next);
      stickyListeners.get(key)?.forEach(listener => listener());
    },
    [key],
  );
  return [value, set];
}
