// One existing A/B shuttle clock, shared by the viewer and legacy source keys.
import { createStore, useStore } from './store';
export const slotPlayback = createStore<{ which: 'A' | 'B'; rate: number }>({ which: 'A', rate: 0 });
export const setSlotPlayback = (which: 'A' | 'B', rate: number) => slotPlayback.set({ which, rate });
export const pauseSlotPlayback = () => slotPlayback.set(s => ({ ...s, rate: 0 }));
export const useSlotPlayback = () => useStore(slotPlayback, s => s);

/** Existing J/K/L rates, also used by visible source shuttle buttons. */
export function shuttleSlot(which: 'A' | 'B', direction: -1 | 0 | 1) {
  if (!direction) { pauseSlotPlayback(); return; }
  const rate = slotPlayback.get().rate;
  setSlotPlayback(which, rate * direction > 0 ? Math.min(8, Math.abs(rate) * 2) * direction : direction);
}
