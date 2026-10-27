import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseControlFeedback, type ControlFeedback, type SourceId } from '@moshpit/core';
import { ControlHub, PushThrottle, type Session } from '../src/control/hub';
import { changedControlValues, discover } from '../src/control/discovery';
import { newBlock, newProject, withChain } from '../src/project/build';

afterEach(() => vi.useRealTimers());

describe('exact base feedback across ordinary edits', () => {
  it('distinguishes reset initial from neutral fallback for old projects', () => {
    const doc = newProject('reset');
    doc.timeline.blocks = [withChain(newBlock('picture', 'S' as SourceId, 0, 90), [{ kind: 'fx.saturation' }])];
    const node = doc.timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.saturation')!;
    delete node.params.amount;
    expect(discover(doc, 1).targets.find(t => t.param.key === 'amount')).toMatchObject({ value: 100, param: { default: 100, initial: 170 } });
  });
  it('pushes the definition default when undo removes a parameter override', () => {
    const before = newProject('undo');
    before.timeline.blocks = [withChain(newBlock('picture', 'S' as SourceId, 0, 90), [{ kind: 'fx.posterize', params: { levels: 7 } }])];
    const next = structuredClone(before);
    const node = next.timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.posterize')!;
    delete node.params.levels;
    const target = discover(next, 1).targets.find(t => t.param.key === 'levels')!;
    expect(target.value).not.toBe(7);
    expect(changedControlValues(before, next, 1)).toEqual([target]);
    expect(changedControlValues(next, next, 1)).toEqual([]);
  });
  it('preserves fine base edits even below the animation epsilon', () => {
    vi.useFakeTimers(); const values: unknown[] = [];
    const throttle = new PushThrottle((_p, value) => values.push(value), 50);
    throttle.offer('/p', 137.43, undefined, 400);
    throttle.offer('/p', 137.44, undefined, 400);
    vi.advanceTimersByTime(50);
    expect(values).toEqual([137.43, 137.44]); throttle.dispose();
  });
  it('does not deliver an obsolete queued value after a quick reversal', () => {
    vi.useFakeTimers(); const values: unknown[] = [];
    const throttle = new PushThrottle((_p, value) => values.push(value), 50);
    throttle.offer('/p', 10, undefined, 400);
    throttle.offer('/p', 30, undefined, 400);
    throttle.offer('/p', 10, undefined, 400);
    vi.advanceTimersByTime(100);
    expect(values).toEqual([10]); throttle.dispose();
  });
  it('discards pending values from an earlier discovery generation', () => {
    vi.useFakeTimers(); let generation = 1;
    const doc = newProject('generation'), messages: any[] = [];
    const hub = new ControlHub({ snapshot: () => ({ doc, generation }), commit() {}, command() {} }, 'test');
    hub.open({ authed: true, subs: new Set(['/p']), send: m => messages.push(m), close() {} });
    hub.changed('/p', 10, undefined, 100);
    hub.changed('/p', 20, undefined, 100);
    generation++; hub.structureChanged();
    messages.length = 0; // the rediscovered target owns a fresh value, not the queued old one
    vi.advanceTimersByTime(100);
    expect(messages).toEqual([]);
    hub.changed('/p', 10, undefined, 100);
    expect(messages).toEqual([{ type: 'value', path: '/p', value: 10 }]);
    hub.dispose();
  });
});

describe('read-only ui-feedback.v1', () => {
  function setup(initial?: ControlFeedback) {
    let feedback = initial;
    const doc = newProject('feedback');
    const messages: any[] = [], stranger: any[] = [];
    const hub = new ControlHub({ snapshot: () => ({ doc, generation: 7, feedback, workspace: feedback?.workspace }), commit() {}, command() {} }, 'test');
    const session: Session = { authed: false, subs: new Set(), send: m => messages.push(m), close() {} };
    hub.open(session);
    hub.open({ authed: false, subs: new Set(), send: m => stranger.push(m), close() {} });
    hub.handle(session, JSON.stringify({ type: 'hello', protocol: 'moshpit-control', version: 1, token: 'test' }));
    return { hub, session, messages, stranger, set: (value: ControlFeedback) => { feedback = value; hub.feedbackChanged(); } };
  }
  it('hydrates late clients through hello and discovery without changing generation', () => {
    const feedback: ControlFeedback = { workspace: 'browse', values: { in: { text: '120 f', norm: .2 }, clip: { text: '2/8' } } };
    const f = setup(feedback);
    expect(f.messages[0]).toMatchObject({ type: 'welcome', feedback });
    expect(f.messages[0].caps).toContain('ui-feedback.v1');
    f.hub.handle(f.session, JSON.stringify({ type: 'discover' }));
    expect(f.messages.at(-1)).toMatchObject({ type: 'targets', generation: 7, feedback });
    expect(f.stranger).toEqual([]);
    f.hub.dispose();
  });
  it('preserves legacy hosts with no feedback capability or payload', () => {
    const f = setup();
    expect(f.messages[0].caps).not.toContain('ui-feedback.v1');
    expect(f.messages[0].feedback).toBeUndefined();
    f.hub.handle(f.session, JSON.stringify({ type: 'discover' }));
    expect(f.messages.at(-1).feedback).toBeUndefined();
    f.hub.dispose();
  });
  it('coalesces rapid frames, delivers final state, and replaces stale browse state with empty workspace state', () => {
    vi.useFakeTimers();
    const f = setup({ workspace: 'browse', values: {} }); f.messages.length = 0;
    for (let frame = 0; frame < 30; frame++) f.set({ workspace: 'browse', values: { frame: { text: `${frame} f` } } });
    expect(f.messages).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(f.messages).toEqual([{ type: 'ui-feedback', feedback: { workspace: 'browse', values: { frame: { text: '29 f' } } } }]);
    f.set({ workspace: 'browse', values: { frame: { text: '29 f' } } }); vi.advanceTimersByTime(50);
    expect(f.messages).toHaveLength(1);
    f.set({ workspace: 'browse', values: { in: { text: '70 f' } } });
    f.set({ workspace: 'mosh', values: {} }); vi.advanceTimersByTime(50);
    expect(f.messages.at(-1)).toEqual({ type: 'ui-feedback', feedback: { workspace: 'mosh', values: {} } });
    expect(f.stranger).toEqual([]);
    f.hub.dispose();
  });
  it('cancels queued feedback on shutdown', () => {
    vi.useFakeTimers(); const f = setup(); f.messages.length = 0;
    f.set({ workspace: 'browse', values: { zoom: { text: '2x' } } }); f.hub.dispose(); vi.runAllTimers();
    expect(f.messages).toEqual([]);
  });
});

describe('feedback IPC boundary', () => {
  it('accepts numeric zero, empty replacement, and strips unknown keys', () => {
    expect(parseControlFeedback({ workspace: 'browse', values: { in: { text: '0 f', norm: 0 }, extra: { secret: 'ignored' } } }))
      .toEqual({ workspace: 'browse', values: { in: { text: '0 f', norm: 0 } } });
    expect(parseControlFeedback({ workspace: 'mosh', values: { in: null } })).toEqual({ workspace: 'mosh', values: {} });
  });
  it.each([null, [], {}, { workspace: 'wrong', values: {} }, { workspace: 'browse', values: [] },
    ...[NaN, Infinity, -1, 2, '1'].map(norm => ({ workspace: 'browse', values: { in: { text: '0 f', norm } } })),
    ...['', 'x'.repeat(49), 'x\n0'].map(text => ({ workspace: 'browse', values: { in: { text } } })),
  ])('rejects malformed readouts %#', value => expect(parseControlFeedback(value)).toBeNull());
});
