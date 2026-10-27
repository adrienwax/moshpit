import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { startControlServer, DEFAULT_PORT, type ControlServer } from '../src/control/server';
import { ControlHub, PushThrottle, type ControlHost, type ControlWorkspace, type Session } from '../src/control/hub';
import { discover, BYPASS_KEY } from '../src/control/discovery';
import { newBlock, newEdge, newNode, newProject, withChain } from '../src/project/build';
import { NODE_DEFS } from '../src/nodes/defs';
import type { CommandId, CommandOptions, ParamValue, ProjectDoc, SourceId } from '@moshpit/core';

// A project host as main will be: the doc, a control generation, edits committed in place.
const doc: ProjectDoc = newProject('control');
doc.timeline.blocks = [withChain(newBlock('picture', 'S' as SourceId, 0, 90), [{ kind: 'fx.plane-desync' }, { kind: 'fx.feedback' }])];
const state = { generation: 1, commands: [] as CommandId[], options: [] as (CommandOptions | undefined)[], commits: 0 };
const host: ControlHost = {
  snapshot: () => ({ doc, generation: state.generation }),
  commit: (p, v: ParamValue) => {
    state.commits++;
    const m = /\/node\/([^/]+)\/param\/([^/]+)$/.exec(p);
    const n = doc.timeline.blocks[0].graph.nodes.find((x) => x.id === m?.[1]);
    if (n && m![2] === BYPASS_KEY) n.bypass = !!v; else if (n) n.params[m![2]] = v;
    const l = /^\/lfo\/([^/]+)\/(period|phase)$/.exec(p);
    if (l) { const lfo = doc.modulators.lfos.find((x) => x.id === l[1])!; (lfo as unknown as Record<string, unknown>)[l[2]] = v; }
  },
  command: (c, options) => { state.commands.push(c); state.options.push(options); },
  select: (nodeId) => { const b = doc.timeline.blocks[0].id; doc.view.perBlock[b] = { ...(doc.view.perBlock[b] ?? { pan: { x: 0, y: 0 }, zoom: 1 }), selected: [nodeId as never] }; },
};

describe('optional workspace feedback', () => {
  it('announces navigation, deduplicates pushes, and leaves discovery generation unchanged', () => {
    let workspace: ControlWorkspace = 'browse';
    const hub = new ControlHub({ ...host, snapshot: () => ({ doc, generation: 41, workspace }) }, 'test');
    const messages: any[] = [], unauth: any[] = [];
    const session: Session = { authed: false, subs: new Set(), send: m => messages.push(m), close() {} };
    const stranger: Session = { authed: false, subs: new Set(), send: m => unauth.push(m), close() {} };
    hub.open(session); hub.open(stranger);
    hub.handle(session, JSON.stringify({ type: 'hello', protocol: 'moshpit-control', version: 1, token: 'test' }));
    expect(messages[0]).toMatchObject({ type: 'welcome', version: 1, workspace: 'browse' });
    expect(messages[0].caps).toContain('workspace');
    hub.handle(session, JSON.stringify({ type: 'discover', id: 2 }));
    expect(messages.at(-1)).toMatchObject({ type: 'targets', workspace: 'browse', generation: 41 });
    messages.length = 0;
    workspace = 'render'; hub.workspaceChanged(); hub.workspaceChanged();
    expect(messages).toEqual([{ type: 'workspace', workspace: 'render' }]);
    expect(unauth).toEqual([]);
    hub.handle(session, JSON.stringify({ type: 'discover', id: 3 }));
    expect(messages.at(-1)).toMatchObject({ workspace: 'render', generation: 41 });
    hub.dispose();
  });
  it('keeps hosts without workspace feedback compatible with v1', () => {
    const messages: any[] = [];
    const hub = new ControlHub(host, 'test');
    const session: Session = { authed: false, subs: new Set(), send: m => messages.push(m), close() {} };
    hub.open(session);
    hub.handle(session, JSON.stringify({ type: 'hello', protocol: 'moshpit-control', version: 1, token: 'test' }));
    expect(messages[0].workspace).toBeUndefined();
    expect(messages[0].caps).not.toContain('workspace');
    hub.handle(session, JSON.stringify({ type: 'discover' }));
    expect(messages.at(-1).workspace).toBeUndefined();
    const before = messages.length; hub.workspaceChanged();
    expect(messages).toHaveLength(before);
    hub.dispose();
  });
});

describe('rotary-command-mode.v1 validation', () => {
  function fixture() {
    const calls: unknown[] = [], messages: any[] = [];
    const hub = new ControlHub({ ...host, command: (command, options) => calls.push({ command, options }) }, 'test');
    const session: Session = { authed: true, subs: new Set(), send: m => messages.push(m), close() {} };
    const send = (fields: object) => hub.handle(session, JSON.stringify({ type: 'command', command: 'transport.nextFrame', ...fields }));
    return { hub, calls, messages, send };
  }
  it('forwards ten coarse detents exactly once, without expanding IPC traffic', () => {
    const f = fixture(); f.send({ mode: 'coarse', repeat: 10 });
    expect(f.calls).toEqual([{ command: 'transport.nextFrame', options: { mode: 'coarse', repeat: 10 } }]);
    expect(f.messages.at(-1)).toMatchObject({ type: 'ack', repeat: 10 }); f.hub.dispose();
  });
  it.each(['fast', '', null, 1, ['coarse']])('refuses unknown mode %s before dispatch', mode => {
    const f = fixture(); f.send({ mode });
    expect(f.calls).toEqual([]); expect(f.messages.at(-1)).toMatchObject({ type: 'error', code: 'PARAM_OUT_OF_RANGE' }); f.hub.dispose();
  });
  it.each([0, -1, 11, 1.5, '2', null])('refuses invalid repeat %s before dispatch', repeat => {
    const f = fixture(); f.send({ repeat });
    expect(f.calls).toEqual([]); expect(f.messages.at(-1)).toMatchObject({ type: 'error', code: 'PARAM_OUT_OF_RANGE' }); f.hub.dispose();
  });
  it.each(['render.start', 'edit.undo', 'source.addBlock', 'block.freeze', 'source.zoomFit'])('never repeats or modifies discrete action %s', command => {
    const f = fixture(); f.send({ command, repeat: 2 }); f.send({ command, mode: 'coarse' });
    expect(f.calls).toEqual([]); expect(f.messages.every(m => m.type === 'error')).toBe(true);
    f.send({ command }); expect(f.calls).toEqual([{ command, options: undefined }]); f.hub.dispose();
  });
});

let srv: ControlServer;
const endpoint = path.join(os.tmpdir(), `moshpit-control-${process.pid}.json`);
beforeAll(async () => { srv = await startControlServer(host, { endpointFile: endpoint, port: 0, throttleMs: 50 }); });
afterAll(async () => { await srv.close(); });

async function client(hello: Record<string, unknown> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/control`);
  const got: any[] = [], waiters: ((m: any) => void)[] = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); const w = waiters.shift(); if (w) w(m); else got.push(m); });
  await new Promise((r) => ws.once('open', r));
  const next = () => (got.length ? Promise.resolve(got.shift()) : new Promise<any>((r) => waiters.push(r)));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  send({ type: 'hello', protocol: 'moshpit-control', version: 1, client: 'test', token: srv.token, ...hello });
  return { ws, next, send, first: await next() };
}

describe('CONTROL-PROTOCOL.md v1', () => {
  it('discovers selected Chroma trail both in the output chain and while disconnected for editing', () => {
    const project = newProject('selected effect');
    const block = withChain(newBlock('picture', 'S' as SourceId, 0, 90), [{ kind: 'mosh.speed' }, { kind: 'fx.chroma-trail' }, { kind: 'fx.hue-rotate' }]);
    project.timeline.blocks = [block];
    const chroma = block.graph.nodes.find(n => n.kind === 'fx.chroma-trail')!;
    project.view.perBlock[block.id] = { pan: { x: 0, y: 0 }, zoom: 1, selected: [chroma.id] };
    const keys = (d: ReturnType<typeof discover>) => d.slots.find(s => s.nodeId === chroma.id)?.params.map(p => p.split('/').pop());
    const connected = discover(project, 1);
    expect(keys(connected)).toEqual(['amount', 'back', 'spread', 'wet', 'bypass']);
    expect(connected.selected).toEqual({ nodeId: chroma.id, slot: 2 });
    // This is a normal graph-editing state, not a parameterless node: mouse controls still work.
    block.graph.edges = block.graph.edges.filter(e => e.from.node !== chroma.id && e.to.node !== chroma.id);
    const decode = block.graph.nodes.find(n => n.kind === 'decode.webcodecs')!;
    const hue = block.graph.nodes.find(n => n.kind === 'fx.hue-rotate')!;
    block.graph.edges.push(newEdge(decode.id, hue.id));
    const disconnected = discover(project, 2);
    expect(keys(disconnected)).toEqual(keys(connected));
    expect(disconnected.selected?.slot).not.toBeNull();
    expect(disconnected.slots.map(s => s.name)).toEqual(['Speed', 'Hue rotate', 'Chroma trail']);
  });

  it.each(NODE_DEFS.filter(d => d.category === 'Effect'))('exposes $kind while connected and while parked off-chain', def => {
    const project = newProject('effect coverage');
    const block = withChain(newBlock('picture', 'S' as SourceId, 0, 90), [{ kind: def.kind }]);
    project.timeline.blocks = [block];
    const node = block.graph.nodes.find(n => n.kind === def.kind)!;
    const before = discover(project, 1).slots.find(s => s.nodeId === node.id)!;
    block.graph.edges = block.graph.edges.filter(e => e.from.node !== node.id && e.to.node !== node.id);
    const after = discover(project, 2).slots.find(s => s.nodeId === node.id)!;
    expect(after.params).toEqual(before.params);
    expect(after.params).toHaveLength(def.params.length + 1);
  });

  it('keeps Source, Decode, Output and empty selection unavailable even with parked nodes', () => {
    const project = newProject('safe selection');
    const block = newBlock('picture', 'S' as SourceId, 0, 90);
    block.graph.nodes.push(newNode('fx.chroma-trail'));
    project.timeline.blocks = [block];
    for (const node of block.graph.nodes.slice(0, 3)) {
      project.view.perBlock[block.id] = { pan: { x: 0, y: 0 }, zoom: 1, selected: [node.id] };
      const d = discover(project, 1);
      expect(d.slots).toHaveLength(1);
      expect(d.selected).toEqual({ nodeId: node.id, slot: null });
    }
    project.view.perBlock[block.id].selected = [];
    expect(discover(project, 1).selected).toBeNull();
  });

  it('nodes never use the reserved bypass key; dial order follows ctOrder', () => {
    expect(NODE_DEFS.some((d) => d.params.some((p) => p.key === BYPASS_KEY))).toBe(false);
    const d = discover(doc, 1);
    expect(d.slots.map((s) => s.name)).toEqual(['Plane desync', 'Feedback loop']);
    const pd = d.slots[0].params.map((p) => p.split('/').pop());
    expect(pd).toEqual(['dx', 'dy', 'amount', 'channel', 'noise', 'bypass']);
    const lfoPaths = d.targets.filter((t) => t.path.startsWith('/lfo/')).map((t) => t.path);
    expect(lfoPaths).toEqual(doc.modulators.lfos.flatMap((l) => [`/lfo/${l.id}/period`, `/lfo/${l.id}/phase`]));
    expect(d.targets.find((t) => t.path.endsWith('/dx'))!.param).toMatchObject({ label: 'Shift X', min: -200, max: 200, unit: 'px', step: 2 });
  });

  it('writes the endpoint file; default port is 6193', () => {
    expect(JSON.parse(fs.readFileSync(endpoint, 'utf8'))).toMatchObject({ v: 1, port: srv.port, path: '/control', protocol: 'moshpit-control', token: srv.token });
    expect(DEFAULT_PORT).toBe(6193);
  });

  it('requires hello with the token and the protocol version', async () => {
    expect((await client({ token: 'nope' })).first).toMatchObject({ type: 'error', code: 'NOT_AUTHORISED' });
    expect((await client({ version: 2 })).first).toMatchObject({ type: 'error', code: 'PROTOCOL_VERSION' });
    const c = await client();
    expect(c.first).toMatchObject({ type: 'welcome', version: 1, project: { name: 'control' } });
    c.send({ type: 'ping', id: 9 });
    expect(await c.next()).toEqual({ type: 'pong', id: 9 });
    c.ws.close();
  });

  it('discover → subscribe → encoder write → ack + pushed value', async () => {
    const c = await client();
    c.send({ type: 'discover', id: 1 });
    const t = await c.next();
    expect(t).toMatchObject({ type: 'targets', id: 1, generation: 1 });
    const dx = t.slots[0].params[0];
    c.send({ type: 'subscribe', id: 2, paths: [dx] });
    expect(await c.next()).toMatchObject({ type: 'subscribed', id: 2 });
    expect(await c.next()).toMatchObject({ type: 'value', path: dx, value: 24 });
    c.send({ type: 'write', id: 3, write: { target: dx, generation: 1, delta: 3, mode: 'normal', source: 'ct' } });
    expect(await c.next()).toEqual({ type: 'ack', id: 3, value: 30 });
    expect(await c.next()).toMatchObject({ type: 'value', path: dx, value: 30 });
    // Toggle bypass: neither delta nor value flips the bool.
    const bp = t.slots[0].params.at(-1);
    c.send({ type: 'write', id: 4, write: { target: bp, generation: 1, source: 'ct' } });
    expect(await c.next()).toEqual({ type: 'ack', id: 4, value: true });
    expect(doc.timeline.blocks[0].graph.nodes.find((n) => n.kind === 'fx.plane-desync')!.bypass).toBe(true);
    c.ws.close();
  });

  it('rejects a stale generation and tells clients to re-discover', async () => {
    const c = await client();
    const dx = discover(doc, 1).slots[0].params[0];
    state.generation = 2;
    srv.hub.structureChanged();
    expect(await c.next()).toEqual({ type: 'targets-changed', generation: 2 });
    c.send({ type: 'write', id: 5, write: { target: dx, generation: 1, delta: 1, source: 'ct' } });
    expect(await c.next()).toMatchObject({ type: 'error', id: 5, code: 'CONTROL_STALE_TARGET' });
    c.ws.close();
  });

  it('forwards rotary detents in one host call and refuses out-of-range repeats and unknown commands', async () => {
    const c = await client();
    state.commands = []; state.options = [];
    expect(c.first.caps).toContain('rotary-command-mode.v1');
    c.send({ type: 'command', id: 6, command: 'transport.nextFrame', repeat: 4 });
    expect(await c.next()).toEqual({ type: 'ack', id: 6, repeat: 4 });
    c.send({ type: 'command', id: 7, command: 'transport.nextFrame', repeat: 99 });
    expect(await c.next()).toMatchObject({ type: 'error', id: 7, code: 'PARAM_OUT_OF_RANGE' });
    c.send({ type: 'command', id: 8, command: 'rm -rf' });
    expect((await c.next()).type).toBe('error');
    expect(state.commands).toEqual(['transport.nextFrame']);
    expect(state.options).toEqual([{ mode: 'normal', repeat: 4 }]);
    c.ws.close();
  });
});

describe('M1 selection, M3 / M4 commands (additive to v1)', () => {
  it('discover carries the inspector selection; the CT selects by slot; every change is pushed once', async () => {
    const blk = doc.timeline.blocks[0];
    doc.view.perBlock[blk.id] = { pan: { x: 0, y: 0 }, zoom: 1, selected: [] };
    const g = state.generation;
    const c = await client();
    expect(c.first.caps).toEqual(expect.arrayContaining(['selection', 'select']));
    c.send({ type: 'discover', id: 10 });
    const t = await c.next();
    expect(t.selected).toBeNull();
    const [desync, feedback] = t.slots;
    // The CT picks slot 2: Moshpit selects it (the host's select), acks, and the relay pushes it.
    c.send({ type: 'select', id: 11, slot: 2, generation: g });
    expect(await c.next()).toEqual({ type: 'ack', id: 11, selected: { nodeId: feedback.nodeId, slot: 2 } });
    expect(doc.view.perBlock[blk.id].selected).toEqual([feedback.nodeId]);
    srv.hub.selectionChanged();
    expect(await c.next()).toEqual({ type: 'selection', generation: g, selected: { nodeId: feedback.nodeId, slot: 2 } });
    srv.hub.selectionChanged(); // unchanged: no second push
    // The mouse selects the other node: one push, and discover agrees.
    doc.view.perBlock[blk.id].selected = [desync.nodeId as never];
    srv.hub.selectionChanged();
    expect(await c.next()).toEqual({ type: 'selection', generation: g, selected: { nodeId: desync.nodeId, slot: 1 } });
    c.send({ type: 'discover', id: 12 });
    expect((await c.next()).selected).toEqual({ nodeId: desync.nodeId, slot: 1 });
    // A node with no slot, or a stale generation, is refused like a stale write.
    c.send({ type: 'select', id: 13, nodeId: 'gone' });
    expect(await c.next()).toMatchObject({ type: 'error', id: 13, code: 'CONTROL_STALE_TARGET' });
    c.send({ type: 'select', id: 14, slot: 1, generation: g - 1 });
    expect(await c.next()).toMatchObject({ type: 'error', id: 14, code: 'CONTROL_STALE_TARGET' });
    c.send({ type: 'ping', id: 15 });
    expect(await c.next()).toEqual({ type: 'pong', id: 15 }); // nothing else was queued
    c.ws.close();
  });

  it('accepts the IN-page and OUT-page commands, with repeat', async () => {
    const c = await client();
    state.commands = [];
    const added = ['clip.prev', 'clip.next', 'mark.in.nudgeBack', 'mark.in.nudgeForward', 'mark.out.nudgeBack', 'mark.out.nudgeForward', 'render.start'];
    let id = 20;
    for (const command of added) { c.send({ type: 'command', id: ++id, command, repeat: command.startsWith('mark') ? 3 : 1 }); expect(await c.next()).toMatchObject({ type: 'ack', id }); }
    expect(state.commands).toEqual(added);
    c.send({ type: 'discover', id: 30 });
    expect((await c.next()).commands).toEqual(expect.arrayContaining(added));
    c.ws.close();
  });
});

describe('value-push throttle', () => {
  it('turns a frame-rate LFO into ≤ 20 pushes a second, drops insignificant moves, and lands the last value', async () => {
    const out: unknown[] = [];
    const th = new PushThrottle((_p, _v, r) => out.push(r), 50);
    const t0 = Date.now();
    for (let f = 0; f < 60; f++) { th.offer('/x', 0.5, Math.sin(f / 10), 2); await new Promise((r) => setTimeout(r, 16)); } // ~1 s at 60 fps
    const secs = (Date.now() - t0) / 1000;
    await new Promise((r) => setTimeout(r, 80));
    expect(out.length / secs).toBeLessThanOrEqual(22);
    expect(out.at(-1)).toBeCloseTo(Math.sin(59 / 10), 6);
    const quiet: unknown[] = [];
    const q = new PushThrottle((_p, v) => quiet.push(v), 0);
    for (let i = 0; i < 100; i++) q.offer('/y', 10, 10 + i * 0.001, 400); // resolved animation: 0.1 over a 400 range
    expect(quiet.length).toBe(1);
  });
});
