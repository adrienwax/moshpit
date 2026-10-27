// HUD telemetry, UI side (visual language §12.8). The engine pushes GPU load + VRAM, frame cost
// and cache size (engine/src/telemetry); dropped frames are counted here, where they happen: an
// output frame asked for during playback that never reached the screen before the playhead moved.
import type { Telemetry } from '@moshpit/engine';
import { engine } from '../engine';
import { createStore, useStore } from './store';

export interface HudState { t: Telemetry | null; dropped: number }
export const hudStore = createStore<HudState>({ t: null, dropped: 0 });
export const useHud = <U>(sel: (s: HudState) => U) => useStore(hudStore, sel);

engine.onTelemetry?.((t) => hudStore.set((s) => ({ ...s, t })));

export const countDropped = () => hudStore.set((s) => ({ ...s, dropped: s.dropped + 1 }));
export const resetDropped = () => hudStore.set((s) => ({ ...s, dropped: 0 }));
