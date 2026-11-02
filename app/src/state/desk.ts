import { activeBlock, getDoc } from './project';
import { blockStarts } from '../lib/timeline';
import { writeSticky } from './store';
import { setUi } from './ui';
import { pauseSlotPlayback } from './slotPlayback';
import { setWsLayout } from '../layout/model';
const PANES = ['slots', 'clips', 'library', 'program', 'graph', 'block', 'effects', 'edit', 'render', 'detail'];
export type Detail = 'source' | 'processing' | 'block' | 'graph' | 'modulation' | 'capture';
export function openDeskDetail(detail: Detail) {
  if (detail === 'capture') {
    writeSticky('program.captures', true);
    setUi({ playing: false }); pauseSlotPlayback();
  } else {
    writeSticky('program.captures', false);
    writeSticky('desk.detail', detail);
  }
  const monitor = detail === 'capture' || detail === 'processing';
  setWsLayout('mosh', cols => cols.map(c => ({ ...c, stacks: c.stacks.map(s => {
    // A custom layout may dock the monitor and detail together as tabs.
    if (monitor && s.panes.includes('program')) return { ...s, active: s.panes.indexOf('program'), collapsed: false };
    if (s.panes.includes('detail')) return { ...s, active: s.panes.indexOf('detail'), collapsed: monitor };
    return s;
  }) })), PANES);
}

/** Explicit inspection changes Edit position/ownership; ordinary selection never calls it. */
export function inspectSelectedResult() {
  const doc = getDoc();
  const block = activeBlock(doc);
  if (!block) return;
  pauseSlotPlayback();
  writeSticky('program.captures', false);
  writeSticky('program.left', 'program');
  writeSticky('program.activeSide', 'left');
  setUi({ playhead: blockStarts(doc.timeline.blocks)[doc.timeline.blocks.indexOf(block)], playing: false,
    audition: undefined, reveal: undefined, wipe: undefined });
}

