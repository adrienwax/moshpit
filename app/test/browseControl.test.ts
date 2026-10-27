import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, type CommandId, type CommandOptions } from '../../core/src/control';

// Drive the real SliceTrack effects with persistent refs and dependency-aware rerenders.
// The parent rounds source frames exactly as BigPreview does; no browser or engine is launched.
const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { current?: unknown; deps?: readonly unknown[]; cleanup?: void | (() => void) }[],
  effects: [] as (() => void)[],
  ui: {} as any,
  doc: {} as any,
  zoomAt: vi.fn(), fit: vi.fn(), setUi: vi.fn(), setLoupe: vi.fn(), setMarks: vi.fn(), toast: vi.fn(),
}));
vi.mock('react', () => ({
  useRef: (initial: unknown) => {
    const i = harness.cursor++;
    return harness.slots[i] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const i = harness.cursor++;
    const slot = harness.slots[i] ??= { current: initial };
    return [slot.current, (next: unknown) => { slot.current = next; }];
  },
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
    const i = harness.cursor++, previous = harness.slots[i];
    if (previous && deps && previous.deps?.length === deps.length && deps.every((v, j) => Object.is(v, previous.deps![j]))) return;
    const slot = harness.slots[i] = { deps };
    harness.effects.push(() => { previous?.cleanup?.(); slot.cleanup = fn(); });
  },
}));
vi.mock('../src/state/ui', () => ({
  uiStore: { get: () => harness.ui, subscribe: vi.fn() },
  useUi: (selector: (ui: any) => unknown) => selector(harness.ui),
  setUi: (patch: object) => { harness.setUi(patch); Object.assign(harness.ui, patch); },
  setLoupe: harness.setLoupe, setWs: vi.fn(),
}));
vi.mock('../src/state/project', () => ({
  getDoc: () => harness.doc, activeBlock: () => undefined,
  projectStore: { subscribe: vi.fn() }, setMarks: harness.setMarks,
  isFrozen: vi.fn(), redo: vi.fn(), selectBlock: vi.fn(), selectNode: vi.fn(),
  setBypass: vi.fn(), setLfo: vi.fn(), setParam: vi.fn(), toggleFreeze: vi.fn(), undo: vi.fn(),
}));
vi.mock('@moshpit/engine', () => ({ blockSpanFrames: (b: { in: number; out: number }) => b.out - b.in, discoveryShape: () => 'fixture', asMoshpitError: vi.fn(), MoshpitError: Error, parseTargetPath: vi.fn() }));
vi.mock('../src/state/controlWrite', () => ({ commitControlWrite: vi.fn() }));
vi.mock('../src/state/render', () => ({ queueRender: vi.fn(), renderStore: { get: () => [] } }));
vi.mock('../src/lib/osDrop', () => ({ openDropped: vi.fn() }));
vi.mock('../src/components/nodes', () => ({ frameRangeOf: vi.fn() }));
vi.mock('../src/qol/qol', () => ({ toast: harness.toast, toastError: vi.fn() }));
vi.mock('../src/components/TimelineKit', () => ({
  useZoom: (_key: string, frames: number) => ({ view: { start: 0, len: frames }, zoomAt: harness.zoomAt, fit: harness.fit }), useWheelZoom: vi.fn(),
  MarkHandles: () => null, Ticks: () => null, ZoomButtons: () => null, ZoomNav: () => null,
  dragFrames: vi.fn(), rulerTime: vi.fn(),
}));
vi.mock('../src/radial/RadialPick', () => ({ RadialPick: () => null }));
import { BROWSE_COMMANDS, createBrowseCommands, dispatchBrowseCommand, registerBrowseControls, registerBrowseTransport, type BrowseSelection } from '../src/state/browseControl';
import { installControlBridge } from '../src/state/control';
import { PreviewTransport } from '../src/components/PreviewTransport';
import { SliceTrack, type SliceTrackProps } from '../src/components/SliceTrack';

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.clearAllMocks(); harness.cursor = 0; harness.slots = []; harness.effects = [];
  harness.ui = { ws: 'browse', snap: 'frame', playing: false, playhead: 77,
    sliceTarget: 'B', loupes: { A: { src: 'hidden-A', frame: 8 }, B: { src: 'hidden-B', frame: 14 } } };
  harness.doc = { settings: { fps: { num: 60, den: 1 } }, resources: { sources: [
    { id: 'hidden-A', marks: [{ in: 1, out: 50 }] }, { id: 'hidden-B', marks: [{ in: 2, out: 60 }] },
  ], conforms: [] }, timeline: { blocks: [{ kind: 'picture', in: 0, out: 200, repeat: 1 }] } };
});
afterEach(() => {
  harness.slots.forEach(slot => slot.cleanup?.());
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function library() {
  const clips: BrowseSelection[] = ['one.mov', 'two.mov', 'three.mov'].map(path => ({ path, frames: 100, frame: 40, marks: null, usable: true }));
  let selected: BrowseSelection | null = clips[1];
  const send = vi.fn(), notice = vi.fn();
  const select = vi.fn((path: string) => { selected = clips.find(c => c.path === path) ?? null; });
  const marks = vi.fn((path: string, value: { in: number; out: number }) => { clips.find(c => c.path === path)!.marks = value; });
  const command = createBrowseCommands({ selection: () => selected, paths: () => clips.map(c => c.path), select, marks, send, notice });
  return { clips, command, send, notice, select, marks, selected: () => selected!, clear: () => { selected = null; } };
}

describe('IN command ownership and selection', () => {
  it('keeps source actions in the typed public command contract', () => {
    const actions: CommandId[] = ['source.selectAll', 'source.sendA', 'source.sendB', 'source.addBlock', 'mark.range.nudgeBack', 'mark.range.nudgeForward', 'folder.prev', 'folder.next', 'source.zoomIn', 'source.zoomOut', 'source.zoomFit'];
    for (const action of actions) { expect(COMMANDS).toContain(action); expect(BROWSE_COMMANDS.has(action)).toBe(true); }
  });
  it('selects visible library clips independently of the hidden A/B loupes, without wrapping', () => {
    const lib = library(), hidden = structuredClone(harness.ui.loupes);
    lib.command('clip.next'); expect(lib.selected().path).toBe('three.mov');
    lib.command('clip.next'); expect(lib.selected().path).toBe('three.mov');
    lib.command('clip.prev'); lib.command('clip.prev'); lib.command('clip.prev');
    expect(lib.selected().path).toBe('one.mov'); expect(harness.ui.loupes).toEqual(hidden);
    expect(harness.setLoupe).not.toHaveBeenCalled();
  });
  it('rejects unrelated and transport commands without changing marks', () => {
    const lib = library(); expect(lib.command('block.freeze')).toBe(false); expect(lib.command('transport.play')).toBe(false);
    expect(lib.marks).not.toHaveBeenCalled(); expect(lib.notice).not.toHaveBeenCalled();
  });
  it.each(['source.sendA', 'source.sendB', 'source.addBlock'])('blocks %s with no selection, no marks, or an unusable clip', command => {
    const lib = library(); lib.command(command);
    expect(lib.notice).toHaveBeenLastCalledWith(expect.stringContaining('Mark In and Out'));
    lib.selected().marks = { in: 5, out: 10 }; lib.selected().usable = false; lib.command(command);
    expect(lib.notice).toHaveBeenLastCalledWith(expect.stringContaining('cannot be imported'));
    lib.clear(); lib.command(command);
    expect(lib.notice).toHaveBeenLastCalledWith(expect.stringContaining('Choose a clip'));
    expect(lib.send).not.toHaveBeenCalled();
  });
  it.each([['source.sendA', 'A', false], ['source.sendB', 'B', false], ['source.addBlock', 'A', true]] as const)('sends marked selection through %s', (command, target, addBlock) => {
    const lib = library(); lib.selected().marks = { in: 10, out: 20 }; lib.command(command);
    expect(lib.send).toHaveBeenCalledExactlyOnceWith(target, addBlock);
    expect(lib.notice).not.toHaveBeenCalled();
  });
});

describe('IN marks use exclusive OUT and current state on each detent', () => {
  it('selects the entire clip including its final frame', () => {
    const lib = library(); lib.command('source.selectAll'); expect(lib.selected().marks).toEqual({ in: 0, out: 100 });
  });
  it('sets OUT to the first excluded frame and moves IN back if needed', () => {
    const lib = library(); lib.selected().frame = 12; lib.selected().marks = { in: 30, out: 90 };
    lib.command('mark.out'); expect(lib.selected().marks).toEqual({ in: 11, out: 12 });
  });
  it.each([[-50, { in: 0, out: 1 }], [1000, { in: 98, out: 99 }]])('clamps mark.out at playhead %s to a nonempty range', (frame, expected) => {
    const lib = library(); lib.selected().frame = frame as number; lib.selected().marks = { in: 99, out: 100 };
    lib.command('mark.out'); expect(lib.selected().marks).toEqual(expected);
  });
  it('clamps IN at the final frame and extends OUT to keep that frame', () => {
    const lib = library(); lib.selected().frame = 1000; lib.selected().marks = { in: 2, out: 10 };
    lib.command('mark.in'); expect(lib.selected().marks).toEqual({ in: 99, out: 100 });
  });
  it('preserves a one-frame clip for all mark operations', () => {
    const lib = library(); lib.selected().frames = 1;
    for (const command of ['mark.in', 'mark.out', 'mark.in.nudgeBack', 'mark.in.nudgeForward', 'mark.out.nudgeBack', 'mark.out.nudgeForward']) {
      lib.command(command); expect(lib.selected().marks).toEqual({ in: 0, out: 1 });
    }
  });
  it('accumulates consecutive IN and OUT deltas without a render and clamps both edges', () => {
    const lib = library(); lib.selected().marks = { in: 10, out: 20 };
    for (let n = 0; n < 3; n++) lib.command('mark.in.nudgeForward');
    for (let n = 0; n < 4; n++) lib.command('mark.out.nudgeBack');
    expect(lib.selected().marks).toEqual({ in: 13, out: 16 });
    for (let n = 0; n < 110; n++) { lib.command('mark.in.nudgeBack'); lib.command('mark.out.nudgeForward'); }
    expect(lib.selected().marks).toEqual({ in: 0, out: 100 });
    for (let n = 0; n < 110; n++) lib.command('mark.in.nudgeForward');
    lib.command('mark.out.nudgeBack'); expect(lib.selected().marks).toEqual({ in: 99, out: 100 });
  });
});

describe('visible IN registry and command bridge', () => {
  it('isolates transport from marks and keeps a replacement registration when the old owner unmounts', () => {
    const old = vi.fn(() => true), latest = vi.fn(() => true), transport = vi.fn(() => true);
    const removeOld = registerBrowseControls(old); cleanups.push(removeOld);
    const removeNew = registerBrowseControls(latest); cleanups.push(removeNew);
    const removeTransport = registerBrowseTransport(transport); cleanups.push(removeTransport);
    removeOld(); expect(dispatchBrowseCommand('mark.in')).toBe(true);
    expect(latest).toHaveBeenCalledExactlyOnceWith('mark.in'); expect(old).not.toHaveBeenCalled();
    expect(dispatchBrowseCommand('transport.play')).toBe(true); expect(transport).toHaveBeenCalledExactlyOnceWith('transport.play');
    removeNew(); expect(dispatchBrowseCommand('mark.in')).toBe(false);
    expect(dispatchBrowseCommand('transport.stop')).toBe(true);
    removeTransport(); expect(dispatchBrowseCommand('transport.stop')).toBe(false);
  });
  it('does not let an old transport cleanup unregister its successor', () => {
    const old = registerBrowseTransport(() => true), latest = vi.fn(() => true);
    const remove = registerBrowseTransport(latest); cleanups.push(old, remove); old();
    expect(dispatchBrowseCommand('transport.nextFrame')).toBe(true); expect(latest).toHaveBeenCalledOnce();
  });
  function bridge() {
    let receive!: (message: { command: string } & CommandOptions) => void;
    vi.stubGlobal('window', { moshpitControl: { publish: vi.fn(), onCommit: vi.fn(), onCommand: (fn: typeof receive) => { receive = fn; } } });
    installControlBridge(); return (command: string, options?: CommandOptions) => receive({ command, ...options });
  }
  it('routes IN commands before hidden loupe or program mutations', () => {
    const lib = library(), transport = vi.fn(() => true), command = bridge();
    cleanups.push(registerBrowseControls(lib.command), registerBrowseTransport(transport));
    command('clip.next'); command('mark.in'); command('transport.nextFrame');
    expect(lib.selected().path).toBe('three.mov'); expect(lib.selected().marks?.in).toBe(40);
    expect(transport).toHaveBeenCalledExactlyOnceWith('transport.nextFrame');
    expect(harness.setLoupe).not.toHaveBeenCalled(); expect(harness.setMarks).not.toHaveBeenCalled(); expect(harness.setUi).not.toHaveBeenCalled();
  });
  it('uses project fps for a batched coarse MOSH jump and clamps at the arrangement end', () => {
    const command = bridge(); harness.ui.ws = 'mosh';
    command('transport.nextFrame', { mode: 'coarse', repeat: 2 });
    expect(harness.ui.playhead).toBe(197);
    expect(harness.setUi).toHaveBeenCalledTimes(1);
    command('transport.nextFrame', { mode: 'coarse', repeat: 10 });
    expect(harness.ui.playhead).toBe(199);
    command('transport.prevFrame', { mode: 'fine', repeat: 2 });
    expect(harness.ui.playhead).toBe(197);
    command('transport.prevFrame', { mode: 'coarse', repeat: 10 });
    expect(harness.ui.playhead).toBe(0);
  });
  it('gives guidance with no mounted IN handler instead of falling through to hidden loupes', () => {
    const command = bridge(); command('mark.in'); command('transport.nextFrame');
    expect(harness.toast).toHaveBeenCalledTimes(2); expect(harness.setMarks).not.toHaveBeenCalled(); expect(harness.setUi).not.toHaveBeenCalled();
  });
  it('blocks source-only actions outside IN but preserves normal MOSH transport', () => {
    const lib = library(), command = bridge(); cleanups.push(registerBrowseControls(lib.command));
    harness.ui.ws = 'mosh'; command('source.selectAll'); command('source.sendA');
    expect(lib.marks).not.toHaveBeenCalled(); expect(lib.send).not.toHaveBeenCalled(); expect(harness.toast).toHaveBeenCalledTimes(2);
    command('transport.nextFrame'); expect(harness.ui.playhead).toBe(78);
    command('transport.play'); expect(harness.ui.playing).toBe(true);
  });
});

function sourceTrack(initialFrame = 0, frames = 100) {
  let now = 0, nextId = 0;
  const raf = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { raf.set(++nextId, fn); return nextId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => raf.delete(id));
  const props: SliceTrackProps = { frame: initialFrame, frames, fps: { num: 24, den: 1 }, bpm: 120,
    marks: null, setMarks: vi.fn(), browseControl: true, zoomKey: 'raw:first.mov',
    setFrame: vi.fn(f => { props.frame = Math.round(f); }),
  };
  let tree: any;
  function render() { harness.cursor = 0; tree = SliceTrack(props); harness.effects.splice(0).forEach(effect => effect()); }
  function tick(dt = 1000 / 60) {
    now += dt; const scheduled = [...raf.values()]; raf.clear(); scheduled.forEach(fn => fn(now)); render();
  }
  render(); return { props, render, tick, raf, tree: () => tree };
}

describe('visible IN transport and fractional shuttle', () => {
  it('advances 24 frames over 60 refreshes when the parent stores only integer frames', () => {
    const track = sourceTrack(); dispatchBrowseCommand('transport.play');
    for (let n = 0; n < 60; n++) track.tick();
    expect(track.props.frame).toBe(24);
    expect(track.props.setFrame).toHaveBeenCalledTimes(60);
    expect(harness.setUi).not.toHaveBeenCalled();
  });
  it('applies several CT frame detents before React paints, then clamps at both boundaries', () => {
    const track = sourceTrack(2, 5);
    dispatchBrowseCommand('transport.nextFrame'); dispatchBrowseCommand('transport.nextFrame'); dispatchBrowseCommand('transport.nextFrame');
    expect(track.props.frame).toBe(4);
    for (let n = 0; n < 6; n++) dispatchBrowseCommand('transport.prevFrame');
    expect(track.props.frame).toBe(0);
  });
  it('honors an external seek while shuttling and stops on the final frame', () => {
    const track = sourceTrack(); dispatchBrowseCommand('transport.play'); track.tick();
    track.props.frame = 98; track.render(); track.tick(1000 / 24);
    expect(track.props.frame).toBe(99);
    const calls = vi.mocked(track.props.setFrame).mock.calls.length; track.tick(500);
    expect(track.props.setFrame).toHaveBeenCalledTimes(calls);
  });
  it('stops shuttle on explicit stop and on a different source', () => {
    const track = sourceTrack(); dispatchBrowseCommand('transport.play'); track.tick(100);
    dispatchBrowseCommand('transport.stop'); const stopped = track.props.frame; track.tick(500);
    expect(track.props.frame).toBe(stopped);
    dispatchBrowseCommand('transport.play'); track.props.zoomKey = 'raw:second.mov'; track.props.frame = 50; track.render(); track.tick(500);
    expect(track.props.frame).toBe(50);
  });
  it('removes its CT transport and scheduled animation on unmount', () => {
    const track = sourceTrack(); dispatchBrowseCommand('transport.play');
    harness.slots.forEach(slot => { slot.cleanup?.(); slot.cleanup = undefined; });
    expect(track.raf.size).toBe(0); expect(dispatchBrowseCommand('transport.play')).toBe(false);
  });
});


describe('six-dial IN range, folder and zoom contract', () => {
  it('uses the latest source rate for coarse ranges and keeps fine movement at one frame', () => {
    const lib = library(); lib.selected().fps = 30000 / 1001; lib.selected().marks = { in: 10, out: 30 };
    lib.command('mark.range.nudgeForward', { mode: 'coarse', repeat: 2 });
    expect(lib.selected().marks).toEqual({ in: 70, out: 90 });
    expect(lib.marks).toHaveBeenCalledTimes(1);
    lib.command('mark.range.nudgeForward', { mode: 'coarse' });
    expect(lib.selected().marks).toEqual({ in: 80, out: 100 });
    lib.command('clip.prev'); lib.selected().fps = 24; lib.selected().marks = { in: 10, out: 80 };
    lib.command('mark.in.nudgeForward', { mode: 'coarse' });
    expect(lib.selected().marks).toEqual({ in: 34, out: 80 });
    lib.command('mark.out.nudgeBack', { mode: 'fine', repeat: 2 });
    expect(lib.selected().marks).toEqual({ in: 34, out: 78 });
  });
  it('steps folders in groups of five, even with no clip selected', () => {
    const folderStep = vi.fn();
    const command = createBrowseCommands({ selection: () => null, paths: () => [], select() {}, marks() {}, send() {}, notice() {}, folderStep });
    command('folder.next', { mode: 'coarse', repeat: 2 });
    expect(folderStep).toHaveBeenCalledExactlyOnceWith(10);
  });
  it('coarse zoom applies three increments per detent in one viewport operation', () => {
    sourceTrack(40); dispatchBrowseCommand('source.zoomIn', { mode: 'coarse', repeat: 2 });
    expect(harness.zoomAt).toHaveBeenCalledExactlyOnceWith(Math.pow(.8, 6), 40);
  });
  it('moves the range from latest state on every detent while preserving length at source boundaries', () => {
    const lib = library(); lib.selected().marks = { in: 10, out: 30 };
    for (let n = 0; n < 15; n++) lib.command('mark.range.nudgeBack');
    expect(lib.selected().marks).toEqual({ in: 0, out: 20 });
    for (let n = 0; n < 150; n++) lib.command('mark.range.nudgeForward');
    expect(lib.selected().marks).toEqual({ in: 80, out: 100 });
    lib.command('source.selectAll'); lib.command('mark.range.nudgeBack');
    expect(lib.selected().marks).toEqual({ in: 0, out: 100 });
  });
  it('does not manufacture a range and can leave an empty folder', () => {
    const lib = library(); lib.command('mark.range.nudgeForward');
    expect(lib.marks).not.toHaveBeenCalled(); expect(lib.notice).toHaveBeenCalledWith('Mark a range before moving it.');
    const folderStep = vi.fn();
    const command = createBrowseCommands({ selection: () => null, paths: () => [], select() {}, marks() {}, send() {}, notice() {}, folderStep });
    command('folder.next'); command('folder.prev');
    expect(folderStep.mock.calls).toEqual([[1], [-1]]);
  });
  it('zooms around the visible playhead, fits, and rejects delayed input aimed at a replaced clip', () => {
    const track = sourceTrack(40); let current = true;
    track.props.isCurrent = () => current; track.render();
    dispatchBrowseCommand('source.zoomIn'); dispatchBrowseCommand('source.zoomOut'); dispatchBrowseCommand('source.zoomFit');
    expect(harness.zoomAt.mock.calls).toEqual([[.8, 40], [1.25, 40]]); expect(harness.fit).toHaveBeenCalledOnce();
    current = false;
    expect(dispatchBrowseCommand('source.zoomIn')).toBe(false);
    expect(dispatchBrowseCommand('transport.nextFrame')).toBe(false);
    expect(harness.zoomAt).toHaveBeenCalledTimes(2); expect(track.props.frame).toBe(40);
  });
});

// Exercise the actual main-view callbacks, not a second transport implementation.
function element(node: any, match: (node: any) => boolean): any {
  if (!node || typeof node !== 'object') return undefined;
  if (match(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = element(child, match); if (found) return found;
  }
}
describe('shared source preview controls', () => {
  it('steps one source frame even with bar snap, clamps boundaries, and does not touch the edit', () => {
    harness.ui.snap = 'bar';
    const track = sourceTrack(17, 30);
    track.props.previewTarget = 'Source fixture'; track.render();
    const buttons = () => PreviewTransport(element(track.tree(), n => n.type === PreviewTransport).props);
    element(buttons(), n => n.props?.['aria-label'] === 'Next frame').props.onClick();
    expect(track.props.frame).toBe(18); track.render();
    element(buttons(), n => n.props?.['aria-label'] === 'Go to last frame').props.onClick();
    expect(track.props.frame).toBe(29); track.render();
    element(buttons(), n => n.props?.['aria-label'] === 'Next frame').props.onClick();
    expect(track.props.frame).toBe(29);
    element(buttons(), n => n.props?.['aria-label'] === 'Return to start').props.onClick();
    track.render();
    element(buttons(), n => n.props?.['aria-label'] === 'Previous frame').props.onClick();
    expect(track.props.frame).toBe(0);
    expect(harness.ui.playhead).toBe(77);
    expect(harness.setUi).not.toHaveBeenCalled();
  });
  it('shows CT play/stop state and pauses without rewinding; ignores a replaced source', () => {
    const track = sourceTrack(10, 100);
    track.props.previewTarget = 'Source fixture'; track.render();
    dispatchBrowseCommand('transport.play'); track.tick();
    expect(element(track.tree(), n => n.type === PreviewTransport).props.playing).toBe(true);
    dispatchBrowseCommand('transport.stop'); track.render();
    const pausedAt = track.props.frame;
    const model = element(track.tree(), n => n.type === PreviewTransport).props;
    expect(model.playing).toBe(false);
    track.tick(); expect(track.props.frame).toBe(pausedAt);
    track.props.isCurrent = () => false; track.render();
    element(track.tree(), n => n.type === PreviewTransport).props.onSeek(80);
    expect(track.props.frame).toBe(pausedAt);
  });
});
