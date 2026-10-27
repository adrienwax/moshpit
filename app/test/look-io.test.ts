import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collapseSelection, DEF_BY_KIND, lookFrom, newId, stampLook, inlineContainers } from '@moshpit/engine';
import { newBlock, newEdge, newNode, withChain } from '../../engine/src/project/build';
import { LOOK_MAX_BYTES, parsePortableLook, serializePortableLook } from '../../engine/src/project/lookIO';
import { readLookFile, writeLookFile } from '../electron/look-files';
import { importLookDialog, importLookText } from '../src/state/lookIO';
import { emptyDoc, getDoc, projectStore, undo } from '../src/state/project';
import { host } from '../src/host';

function fixture() {
  const block = withChain(newBlock('picture', 'source' as never, 0, 24), [{ kind: 'fx.chroma-drift' }, { kind: 'fx.posterize', params: { levels: 5 } }]);
  const ids = block.graph.nodes.filter(n => n.kind.startsWith('fx.')).map(n => n.id);
  const c = newId();
  const graph = collapseSelection(block.graph, ids, { container: c, groupIn: newId(), groupOut: newId(), edge: () => newId() }, (n,p) => DEF_BY_KIND.get(n.kind)?.outputs.find(o => o.key === p)?.type);
  const box = graph.nodes.find(n => n.id === c)!;
  const post = box.body!.graph.nodes.find(n => n.kind === 'fx.posterize')!;
  box.body!.macros = [{ key: 'crunch' as never, label: 'Crunch', help: '', min: 0, max: 1, default: 0, target: { node: post.id, param: 'levels' as never }, map: { from: 16, to: 2, curve: 'linear' } }];
  box.params.crunch = 0.75;
  post.bypass = true;
  post.bindings.levels = { expression: { source: '0.5 + sin(beat) * 0.2', op: 'replace' } };
  return lookFrom(box, 'Portable VHS');
}
const raw = () => JSON.parse(serializePortableLook(fixture()));
const post = (r: any) => r.look.body.graph.nodes.find((n: any) => n.kind === 'fx.posterize');
const dirs: string[] = [];
afterEach(async () => { delete host.looks; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('portable saved-look files', () => {
  it('round-trips graph, turned macros, authored defaults, bypass and standalone expressions; old v1 files remain compatible', () => {
    const look = fixture();
    expect(parsePortableLook(serializePortableLook(look))).toEqual(look);
    const old = raw(); delete old.look.params;
    const legacy = parsePortableLook(JSON.stringify(old));
    expect(stampLook(legacy, { x: 0, y: 0 }).params).toEqual({});
  });
  it.each(['encoded', 'picture', 'spanning'])('accepts complete %s-domain looks', domain => {
    const block = withChain(newBlock('picture', 'source' as never, 0, 24), [{ kind: 'mosh.hold' }, { kind: 'fx.posterize' }]);
    const picked = block.graph.nodes.filter(n => domain === 'encoded' ? n.kind.startsWith('mosh.') : domain === 'picture' ? n.kind.startsWith('fx.') : !['source.clip', 'output.sink'].includes(n.kind));
    const c = newId();
    const g = collapseSelection(block.graph, picked.map(n => n.id), { container: c, groupIn: newId(), groupOut: newId(), edge: () => newId() }, (n,p) => DEF_BY_KIND.get(n.kind)?.outputs.find(o => o.key === p)?.type);
    const look = lookFrom(g.nodes.find(n => n.id === c)!, domain);
    expect(parsePortableLook(serializePortableLook(look)).body).toEqual(look.body);
  });
  it('remaps authored input-order edge references with copied graph identities', () => {
    const look = fixture(), n = look.body.graph.nodes.find(n => n.kind === 'fx.posterize')!;
    const edge = look.body.graph.edges.find(e => e.to.node === n.id)!;
    n.inputOrder = { in: [edge.id] };
    const back = parsePortableLook(serializePortableLook(look));
    const copy = stampLook(back, { x: 0, y: 0 });
    const copied = copy.body!.graph.nodes.find(n => n.kind === 'fx.posterize')!;
    expect(copied.inputOrder!.in).toEqual(copy.body!.graph.edges.filter(e => e.to.node === copied.id).map(e => e.id));
    expect(copied.inputOrder!.in).not.toEqual(n.inputOrder.in);
    expect(inlineContainers({ nodes: [copy], edges: [] }).graph.nodes.find(n => n.kind === 'fx.posterize')!.inputOrder).toEqual(copied.inputOrder);
  });
  it('round-trips a branched blend without flattening its two input paths', () => {
    const look = fixture(), g = look.body.graph;
    const input = g.nodes.find(n => n.kind === 'group.in')!, output = g.nodes.find(n => n.kind === 'group.out')!;
    const a = g.nodes.find(n => n.kind === 'fx.chroma-drift')!, b = g.nodes.find(n => n.kind === 'fx.posterize')!, mix = newNode('route.mix');
    g.nodes.push(mix);
    g.edges = [newEdge(input.id, a.id, look.body.ports.in[0].key), newEdge(input.id, b.id, look.body.ports.in[0].key), newEdge(a.id, mix.id, 'out', 'a'), newEdge(b.id, mix.id, 'out', 'b'), newEdge(mix.id, output.id, 'out', look.body.ports.out[0].key)];
    const back = parsePortableLook(serializePortableLook(look));
    expect(back.body).toEqual(look.body);
    expect(back.body.graph.edges.filter(e => e.to.node === mix.id).map(e => e.to.port)).toEqual(['a', 'b']);
  });
  it.each(['lfo', 'value'])('rejects direct project %s links instead of silently dropping them', key => {
    const r = raw(); post(r).bindings.levels = { [key]: { lfoId: 'missing', valueId: 'missing' } };
    expect(() => parsePortableLook(JSON.stringify(r))).toThrow(/project LFO or Value/);
  });
  it.each(['sin(LFO (1))', 'beat > 2 ? 0.5 : value(1)', 'max(0.1, lfo(value(2)))'])('parses nested expression dependencies: %s', source => {
    const r = raw(); post(r).bindings.levels.expression.source = source;
    expect(() => parsePortableLook(JSON.stringify(r))).toThrow(/lfo\(\) or value\(\)/);
  });
  it.each(['direct', 'expression'])('checks %s dependencies recursively before refusing a nested container', kind => {
    const r = raw(), nested = raw().look.body;
    const inner = nested.graph.nodes.find((n: any) => n.kind === 'fx.posterize');
    inner.bindings.levels = kind === 'direct' ? { value: { valueId: 'external' } } : { expression: { source: 'value(1)', op: 'replace' } };
    r.look.body.graph.nodes.push({ id: 'nested', kind: 'group.container', body: nested });
    expect(() => parsePortableLook(JSON.stringify(r))).toThrow(kind === 'direct' ? /project LFO or Value/ : /lfo\(\) or value\(\)/);
  });
  it('refuses silent data loss, malformed shapes and unrecognized versions', () => {
    const broken = raw(); broken.look.body.graph.edges[0].to.node = 'missing';
    expect(() => parsePortableLook(JSON.stringify(broken))).toThrow(/broken wires/);
    const dup = raw(); dup.look.body.graph.nodes.push(dup.look.body.graph.nodes[0]);
    expect(() => parsePortableLook(JSON.stringify(dup))).toThrow(/duplicate node/);
    const unsupported = raw(); post(unsupported).defVersion = 900;
    expect(() => parsePortableLook(JSON.stringify(unsupported))).toThrow(/older node/);
    const macro = raw(); macro.look.body.macros[0].target.param = 'missing';
    expect(() => parsePortableLook(JSON.stringify(macro))).toThrow(/macro pointing/);
    expect(() => parsePortableLook('{')).toThrow(/not valid JSON/);
    expect(() => parsePortableLook(JSON.stringify({ schema: 'moshpit.recipe', version: 2 }))).toThrow(/Older macro-only recipes/);
    expect(() => parsePortableLook(' '.repeat(LOOK_MAX_BYTES + 1))).toThrow(/4 MB/);
  });
  it('imports a fresh, non-colliding master in one Undo without placing it or changing existing copies', () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    const text = serializePortableLook(fixture()), a = importLookText(text), before = projectStore.get();
    const b = importLookText(text);
    expect(b.name).toBe('Portable VHS 2'); expect(b.id).not.toBe(a.id);
    expect(getDoc().timeline).toBe(before.doc.timeline);
    expect(getDoc().components!.looks[0]).toBe(before.doc.components!.looks[0]);
    expect(projectStore.get().past.length).toBe(before.past.length + 1);
    undo(); expect(getDoc()).toEqual(before.doc);
    const state = projectStore.get();
    expect(() => importLookText('{')).toThrow(); expect(projectStore.get()).toBe(state);
  });
  it('cancellation does nothing, and switching projects during a picker cannot import into the wrong project', async () => {
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    host.looks = { import: async () => ({ ok: true, value: null }), export: async () => ({ ok: true, value: null }) };
    const before = projectStore.get(); expect(await importLookDialog()).toBeNull(); expect(projectStore.get()).toBe(before);
    let reply!: (r: any) => void;
    host.looks.import = () => new Promise(resolve => { reply = resolve; });
    const waiting = importLookDialog();
    projectStore.set({ doc: emptyDoc(), past: [], future: [] });
    const next = projectStore.get(); reply({ ok: true, value: serializePortableLook(fixture()) });
    await expect(waiting).rejects.toThrow(/project changed/); expect(projectStore.get()).toBe(next);
  });
  it('writes atomically to the exact confirmed filename and rejects bad/oversized input without touching existing files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'moshpit-look-')); dirs.push(dir);
    const file = path.join(dir, 'copy.moshlook.json'), text = serializePortableLook(fixture());
    await writeLookFile(file, text); expect(await readLookFile(file)).toBe(text);
    const renamed = fixture(); renamed.name = 'Replacement confirmed by dialog';
    await writeLookFile(file, serializePortableLook(renamed));
    expect(parsePortableLook(await readLookFile(file)).name).toBe(renamed.name);
    await writeLookFile(file, text);
    await expect(writeLookFile(file, '{')).rejects.toThrow(); expect(await readFile(file, 'utf8')).toBe(text);
    await expect(writeLookFile(path.join(dir, 'source.json'), text)).rejects.toThrow(/filename ending/);
    expect(await readdir(dir)).toEqual(['copy.moshlook.json']);
    await writeFile(path.join(dir, 'oversized.json'), ' '.repeat(LOOK_MAX_BYTES + 1));
    await expect(readLookFile(path.join(dir, 'oversized.json'))).rejects.toThrow(/4 MB/);
  });
});
