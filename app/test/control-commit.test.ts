import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlHub, type Session } from '../../engine/src/control/hub';
import { discover, discoveryShape } from '../../engine/src/control/discovery';
import { ControlRequests, type WriteRequest } from '../electron/control-requests';
import { commitControlWrite } from '../src/state/controlWrite';
import { demoProject } from '../src/engine/mockProject';
import { addBlock, addSource, appendEffect, collapseNodes, exposeMacro, emptyDoc, getDoc, projectStore, redo, setParam, undo } from '../src/state/project';
import { MoshpitError } from '@moshpit/core';

function setup() {
  projectStore.set({ doc: emptyDoc(), past: [], future: [] });
  addSource(demoProject().resources.sources[0]);
  const block = addBlock(getDoc().resources.sources[0].id, 0, 24, 'picture');
  appendEffect(block, 'fx.posterize');
  const node = getDoc().timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.posterize')!;
  setParam(block, node.id, 'levels', 7);
  const path = discover(getDoc(), 1).targets.find(t => t.path.endsWith('/levels'))!.path;
  return { block, node: node.id, path, write: { target: path, generation: 1, delta: 1, source: 'ct' as const } };
}
afterEach(() => vi.useRealTimers());

describe('authoritative CT commits', () => {
  it('edits a disconnected selected Chroma trail only, with reset and undo/redo readback', () => {
    const { block } = setup();
    appendEffect(block, 'fx.chroma-trail');
    const doc = structuredClone(getDoc());
    const graph = doc.timeline.blocks[0].graph;
    const chroma = graph.nodes.find(n => n.kind === 'fx.chroma-trail')!;
    const posterize = graph.nodes.find(n => n.kind === 'fx.posterize')!;
    graph.edges = graph.edges.filter(e => e.from.node !== chroma.id && e.to.node !== chroma.id);
    doc.view.perBlock[block] = { pan: { x: 0, y: 0 }, zoom: 1, selected: [chroma.id] };
    projectStore.set({ doc, past: [], future: [] });
    const snapshot = () => discover(getDoc(), 1);
    const slot = snapshot().slots.find(s => s.nodeId === chroma.id)!;
    const target = slot.params.find(p => p.endsWith('/spread'))!;
    const reading = () => snapshot().targets.find(t => t.path === target)!.value;
    expect(snapshot().selected?.slot).toBe(slot.index);
    expect(reading()).toBe(50);
    const write = { target, generation: 1, delta: 1, source: 'ct' as const };
    expect(commitControlWrite(write, 1, doc.id, Date.now() + 1000)).toBe(50.5);
    expect(reading()).toBe(50.5);
    expect(getDoc().timeline.blocks[0].graph.nodes.find(n => n.id === posterize.id)!.params.levels).toBe(7);
    undo(); expect(reading()).toBe(50);
    redo(); expect(reading()).toBe(50.5);
    const { delta: _delta, ...reset } = write;
    expect(commitControlWrite({ ...reset, value: 50 }, 1, doc.id, Date.now() + 1000)).toBe(50);
    expect(reading()).toBe(50);
    expect(getDoc().timeline.blocks[0].graph.edges).toEqual(graph.edges);
  });

  it('a delayed host mirror cannot lose relative detents; ACK waits for committed renderer results', async () => {
    const { write } = setup();
    const stale = getDoc(), incoming: WriteRequest[] = [], output: any[] = [];
    const requests = new ControlRequests(m => incoming.push(m));
    const hub = new ControlHub({ snapshot: () => ({ doc: stale, generation: 1 }), commit: () => { throw new Error('must not use stale absolute path'); }, command() {}, write: w => requests.write(w, stale.id) }, 't');
    const session: Session = { authed: true, subs: new Set(), send: m => output.push(m), close() {} };
    hub.handle(session, JSON.stringify({ type: 'write', id: 1, write }));
    hub.handle(session, JSON.stringify({ type: 'write', id: 2, write }));
    expect(output).toEqual([]);
    for (const m of incoming) {
      const value = commitControlWrite(m.write, 1, m.projectId, m.expiresAt);
      requests.reply({ requestId: m.requestId, result: { value, generation: 1, revision: m.requestId } });
    }
    await Promise.resolve(); await Promise.resolve();
    expect(output.map(m => [m.type, m.value, m.revision])).toEqual([['ack', 8, 1], ['ack', 9, 2]]);
    expect(discover(getDoc(), 1).targets.find(t => t.path === write.target)!.value).toBe(9);
    expect(discover(stale, 1).targets.find(t => t.path === write.target)!.value).toBe(7);
    hub.dispose(); requests.close();
  });

  it('uses a concurrent mouse edit, clamps at the limit, and rejects stale project/generation/deadlines', () => {
    const { block, node, write } = setup();
    const project = getDoc().id, expiry = Date.now() + 1000;
    expect(commitControlWrite(write, 1, project, expiry)).toBe(8);
    setParam(block, node, 'levels', 20);
    expect(commitControlWrite(write, 1, project, expiry)).toBe(21);
    expect(commitControlWrite({ ...write, delta: 999 }, 1, project, expiry)).toBe(32);
    const before = getDoc();
    expect(() => commitControlWrite(write, 2, project, expiry)).toThrowError(/CONTROL_STALE_TARGET/);
    expect(() => commitControlWrite(write, 1, 'different project', expiry)).toThrowError(/CONTROL_STALE_TARGET/);
    expect(() => commitControlWrite(write, 1, project, Date.now())).toThrowError(/CONTROL_STALE_TARGET/);
    expect(getDoc()).toBe(before);
  });

  it('passes a renderer rejection through to the client without a success ACK', async () => {
    const { write } = setup(), output: any[] = [];
    const hub = new ControlHub({ snapshot: () => ({ doc: getDoc(), generation: 1 }), commit() {}, command() {}, write: async () => { throw new MoshpitError('CONTROL_STALE_TARGET'); } }, 't');
    hub.handle({ authed: true, subs: new Set(), send: m => output.push(m), close() {} }, JSON.stringify({ type: 'write', id: 4, write }));
    await Promise.resolve(); await Promise.resolve();
    expect(output).toEqual([expect.objectContaining({ type: 'error', id: 4, code: 'CONTROL_STALE_TARGET' })]);
    hub.dispose();
  });

  it('times out without retry; late replies are ignored; disconnect rejects pending requests and recovery resumes', async () => {
    vi.useFakeTimers();
    const { write } = setup(), incoming: WriteRequest[] = [];
    const requests = new ControlRequests(m => incoming.push(m), 100);
    const timed = requests.write(write, getDoc().id);
    const rejected = expect(timed).rejects.toThrowError(/CT_DISCONNECTED/);
    await vi.advanceTimersByTimeAsync(100); await rejected;
    requests.reply({ requestId: incoming[0].requestId, result: { value: 8, generation: 1, revision: 1 } });
    expect(incoming).toHaveLength(1);
    const closed = requests.write(write, getDoc().id);
    requests.close(); await expect(closed).rejects.toThrowError(/CT_DISCONNECTED/);
    await expect(requests.write(write, getDoc().id)).rejects.toThrowError(/CT_DISCONNECTED/);
    requests.resume(); const recovered = requests.write(write, getDoc().id);
    requests.reply({ requestId: incoming.at(-1)!.requestId, result: { value: 9, generation: 1, revision: 2 } });
    await expect(recovered).resolves.toMatchObject({ value: 9 }); requests.close();
  });

  it('discovery depends on names, wiring, project identity and LFO metadata, but not knob values or node positions', () => {
    setup(); const doc = getDoc(), original = discoveryShape(doc);
    const change = (f: (d: typeof doc) => void) => { const d = structuredClone(doc); f(d); return discoveryShape(d); };
    expect(change(d => { d.id = 'another-project' as never; })).not.toBe(original);
    expect(change(d => { d.timeline.blocks[0].graph.nodes[1].label = 'New label'; })).not.toBe(original);
    expect(change(d => { d.timeline.blocks[0].graph.edges.reverse(); })).not.toBe(original);
    expect(change(d => { d.modulators.lfos[0].label = 'Slow pulse'; })).not.toBe(original);
    expect(change(d => { d.timeline.blocks[0].graph.nodes[1].position.x += 400; })).toBe(original);
    expect(change(d => { d.timeline.blocks[0].graph.nodes.find(n => n.kind === 'fx.posterize')!.params.levels = 11; })).toBe(original);
  });
  it('renaming a look or changing its macro mapping requests rediscovery without invalidating every detent', () => {
    const { block, node } = setup();
    const boxId = collapseNodes(block, [node], 'Crunch');
    const key = exposeMacro(block, boxId, node, 'levels');
    const doc = getDoc(), shape = discoveryShape(doc);
    const changed = (f: (n: typeof doc.timeline.blocks[0]['graph']['nodes'][0]) => void) => {
      const copy = structuredClone(doc); f(copy.timeline.blocks[0].graph.nodes.find(n => n.id === boxId)!); return discoveryShape(copy);
    };
    expect(changed(n => { n.label = 'My new look name'; })).not.toBe(shape);
    expect(changed(n => { n.body!.macros[0].label = 'Density'; })).not.toBe(shape);
    expect(changed(n => { n.body!.macros[0].map!.to = 16; })).not.toBe(shape);
    expect(changed(n => { n.params[key] = 0.4; })).toBe(shape);
    expect(changed(n => { n.body!.graph.nodes.forEach(x => x.position.x += 30); })).toBe(shape);
  });

});
