import { expect, it } from 'vitest';
import { slotPlayback, setSlotPlayback, shuttleSlot } from '../src/state/slotPlayback';
it('visible and legacy source shuttles share bounded signed rates and pause in place', () => {
  setSlotPlayback('A',0);shuttleSlot('A',1);expect(slotPlayback.get()).toEqual({which:'A',rate:1});
  shuttleSlot('A',1);expect(slotPlayback.get().rate).toBe(2);
  for(let i=0;i<5;i++)shuttleSlot('A',1);expect(slotPlayback.get().rate).toBe(8);
  shuttleSlot('A',-1);expect(slotPlayback.get().rate).toBe(-1);
  shuttleSlot('A',-1);expect(slotPlayback.get().rate).toBe(-2);
  shuttleSlot('A',0);expect(slotPlayback.get()).toEqual({which:'A',rate:0});
  shuttleSlot('B',1);expect(slotPlayback.get()).toEqual({which:'B',rate:1});
});
