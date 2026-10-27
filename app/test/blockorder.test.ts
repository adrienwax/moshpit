// Bug hunt P1: the first block must stay a picture block (a motion block first is TIMELINE_NO_PICTURE:
// preview and render stop). Moving, removing or re-kinding a block cannot put a motion block first.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/qol/qol', async (orig) => ({ ...(await orig<object>()), toast: vi.fn() }));
import { toast } from '../src/qol/qol';
import { addBlock, addSource, emptyDoc, getDoc, moveBlock, projectStore, removeBlock, setBlock } from '../src/state/project';
import { demoProject } from '../src/engine/mockProject';

function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const src = getDoc().resources.sources[0].id;
  const pic = addBlock(src, 0, 24, 'picture'), mot = addBlock(src, 24, 48, 'motion'), pic2 = addBlock(src, 48, 72, 'picture');
  return { pic, mot, pic2 };
}
const kinds = () => getDoc().timeline.blocks.map((b) => b.kind).join(' ');

describe('the first block stays a picture block', () => {
  it('moving a motion block to the front is refused, with the reason; other moves still work', () => {
    setup();
    const steps = projectStore.get().past.length;
    expect(moveBlock(1, 0)).toBe(false);
    expect(kinds()).toBe('picture motion picture');
    expect(projectStore.get().past.length).toBe(steps); // no history step
    expect(vi.mocked(toast).mock.calls.at(-1)![0]).toMatch(/first block has to be a picture block/);
    expect(moveBlock(0, 1)).toBe(false); // the picture leaving the front would leave the motion block first
    expect(moveBlock(2, 0)).toBe(true); // a picture block to the front is fine
    expect(kinds()).toBe('picture picture motion');
  });
  it('removing the first picture block when a motion block would lead is refused; re-kinding block 1 too', () => {
    const { pic, mot } = setup();
    removeBlock(pic);
    expect(kinds()).toBe('picture motion picture');
    setBlock(pic, { kind: 'motion' }, 'kind');
    expect(kinds()).toBe('picture motion picture');
    removeBlock(mot); // fine: a picture block still leads
    expect(kinds()).toBe('picture picture');
  });
});
