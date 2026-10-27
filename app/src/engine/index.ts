// The one place the app picks its engine. In Electron the real render worker (engine lane);
// in a plain browser (vite web, no preload) the mock, so the UI still runs without a GPU worker.
import type { NodeDef } from '@moshpit/engine';
import { createMockEngine } from './mockEngine';
import { createWorkerEngine } from './workerEngine';
import { CATALOG } from './catalog';

const inElectron = typeof window !== 'undefined' && !!(window as { moshpitEngine?: unknown }).moshpitEngine;
export const engine = inElectron ? createWorkerEngine() : createMockEngine();
/**
 * Frame requests sent to the engine, by target kind: a deterministic load measure that machine
 * load cannot skew (P1-C, audit). Read by the e2e tests as window.__moshpitFrameAsks.
 */
export const frameAsks: Record<string, number> = { output: 0, node: 0, source: 0 };
const frame = engine.frame.bind(engine);
engine.frame = (target, size, signal) => ((frameAsks[target.kind] = (frameAsks[target.kind] ?? 0) + 1), frame(target, size, signal));
/** Project syncs sent to the engine (R-1): whole-doc updateProject vs one-param setParam. */
export const syncCalls = { updateProject: 0, setParam: 0 };
const update = engine.updateProject.bind(engine), setParam = engine.setParam.bind(engine);
engine.updateProject = (doc) => (syncCalls.updateProject++, update(doc));
engine.setParam = (...a) => (syncCalls.setParam++, setParam(...a));
if (typeof window !== 'undefined') Object.assign(window, { __moshpitFrameAsks: frameAsks, __moshpitSyncCalls: syncCalls });
export const engineKind: 'worker' | 'mock' = inElectron ? 'worker' : 'mock';

// The registry is loaded once at boot (engine.nodeDefs()) and read synchronously after that.
// Seeded with the mock catalogue so first paint never waits.
let registry: NodeDef[] = CATALOG;
export const nodeDefs = () => registry;
export const defOf = (kind: string) => registry.find((d) => d.kind === kind);
export async function loadRegistry() {
  registry = await engine.nodeDefs();
}

export type * from './EngineClient';
