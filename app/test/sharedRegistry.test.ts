import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateSharedRegistry, generateRegistryManifest } from '../../scripts/generate-shared-registry.mts';
import { compatibilityProblems, resolveNodePresentation, type RegistrySnapshot, type NodeLike, type ContainerLike } from '../../shared/graph/registry';
import { macroParams, macroValue, portsOf } from '../../engine/src/graph/container';
import { DEF_BY_KIND } from '../../engine/src/nodes/defs';

const generated = generateSharedRegistry();
const snapshotPath = path.resolve('shared/graph/registry.json');
if (process.env.UPDATE_SHARED_REGISTRY === '1') fs.writeFileSync(snapshotPath, JSON.stringify(generated, null, 2) + '\n');
const manifestPath = path.resolve('shared/graph/registry-manifest.json'); if (process.env.UPDATE_SHARED_REGISTRY === '1') fs.writeFileSync(manifestPath, JSON.stringify(generateRegistryManifest(), null, 2) + '\n');
const registry: RegistrySnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const node = (kind: string, extra: Partial<NodeLike> = {}): NodeLike => ({ id: 'original-id', kind, defVersion: 1, params: {}, bindings: {}, ...extra });
const custom: RegistrySnapshot = { ...registry, definitions: [{ kind: 'test', defVersion: 2, label: 'Test', category: 'Effect', blurb: '',
  inputs: [{ key: 'a', label: 'Same', type: 'VideoFrame' }, { key: 'b', label: 'Same', type: 'Field', available: false }],
  outputs: [{ key: 'out', label: 'Out', type: 'VideoFrame' }], params: [
    { key: 'amount', label: 'Amount', type: 'float', default: 0, initial: 0.5, min: 0, max: 1, unit: '%' },
    { key: 'enabled', label: 'Enabled', type: 'bool', default: true },
    { key: 'mode', label: 'Mode', type: 'enum', default: 'A', options: ['', 'A'] },
    { key: 'newType', label: 'Future', type: 'colour', default: '#000' },
  ], impl: { preview: 'UNAVAILABLE', export: 'UNAVAILABLE' }, freezable: false, creationEligible: false }] };
const n = (params: Record<string, unknown> = {}) => node('test', { defVersion: 2, params });
const body: ContainerLike = {
  graph: { nodes: [node('group.in', { id: 'inner-in' }), node('fx.hue', { id: 'target', params: { hue: 90 } }), node('group.out', { id: 'inner-out' })], edges: [] },
  ports: { in: [{ key: 'saved-in', label: 'Same', type: 'VideoFrame' }], out: [{ key: 'saved-out', label: 'Same', type: 'VideoFrame' }] },
  macros: [{ key: 'spin', label: 'Spin', help: '', min: 0, max: 1, default: 0.1, target: { node: 'target', param: 'hue' }, map: { from: 0, to: 180 } }],
};
describe('shared registry and pure presentation resolver', () => {
  it('freezes exact canonical data with no runtime functions and distinct creation eligibility', () => {
    expect(registry).toEqual(generated); expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toEqual(generateRegistryManifest());
    expect(JSON.parse(JSON.stringify(registry))).toEqual(registry);
    for (const d of registry.definitions) {
      const r = resolveNodePresentation(registry, node(d.kind, { defVersion: d.defVersion }));
      expect(r.definition).toEqual(d);
      if (!d.kind.startsWith('group.')) { expect(r.inputs).toEqual(d.inputs); expect(r.outputs).toEqual(d.outputs); }
    }
    const source = resolveNodePresentation(registry, node('source.clip'));
    expect(source.status).toBe('supported'); expect(source.definition?.creationEligible).toBe(false);
  });
  it('shows all unwired typed ports including same labels and unavailable port without deriving from edges', () => {
    const r = resolveNodePresentation(custom, n());
    expect(r.inputs.map(p => p.key)).toEqual(['a', 'b']);
    expect(r.inputs[1].available).toBe(false);
    expect(r.outputs[0].key).toBe('out');
    expect(r.readOnly).toBe(false); // definition compatibility is separate from runtime availability
  });
  it.each([null, '', false, '0', -1, 2])('retains invalid amount %j without coercion/default write', value => {
    const input = n({ amount: value, opaque: { keep: true } }), before = JSON.stringify(input);
    const r = resolveNodePresentation(custom, input), p = r.parameters[0];
    expect(p.hasStored).toBe(true); expect(p.storedValue).toBe(value); expect(p.base.available).toBe(false);
    expect(r.rawParams).toBe(input.params); expect(r.unknownParams).toEqual({ opaque: { keep: true } });
    expect(JSON.stringify(input)).toBe(before);
  });
  it('distinguishes missing/base neutral, initial/reset and false/zero/empty enum', () => {
    const missing = resolveNodePresentation(custom, n()).parameters[0];
    expect(missing.hasStored).toBe(false); expect(missing.base).toEqual({ available: true, value: 0 });
    expect(missing.initial).toBe(0.5); expect(missing.reset).toEqual({ available: true, value: 0.5 });
    const ps = resolveNodePresentation(custom, n({ amount: 0, enabled: false, mode: '' })).parameters;
    expect(ps.slice(0, 3).map(p => p.base)).toEqual([{ available: true, value: 0 }, { available: true, value: false }, { available: true, value: '' }]);
    expect(ps[3].supported).toBe(false); expect(ps[3].base.available).toBe(false);
  });
  it('requires an explicit evaluation context for driven values and does not pretend to evaluate', () => {
    const input = { ...n({ amount: 0.2 }), bindings: { amount: { lfo: { lfoId: 'missing-context' } } } };
    expect(resolveNodePresentation(custom, input).parameters[0].effective.available).toBe(false);
    expect(resolveNodePresentation(custom, input, { effectiveValues: { amount: { available: true, value: 0.7 } } }).parameters[0].effective).toEqual({ available: true, value: 0.7 });
    expect(input.params.amount).toBe(0.2);
  });
  it.each([[1, 'legacy'], [3, 'future']])('preserves unsupported version %i read-only', (version, status) => {
    const input = { ...n({ amount: 22, extra: null }), defVersion: version as number }, before = JSON.stringify(input);
    const r = resolveNodePresentation(custom, input);
    expect(r.status).toBe(status); expect(r.definition).toBeUndefined(); expect(r.readOnly).toBe(true);
    expect(r.parameters).toEqual([]); expect(r.rawParams).toBe(input.params); expect(JSON.stringify(input)).toBe(before);
  });
  it('unknown kinds retain ids, empty labels and opaque params', () => {
    const input = node('future', { label: '', params: { raw: null } });
    const r = resolveNodePresentation(custom, input);
    expect(r.label).toBe(''); expect(r.id).toBe(input.id); expect(r.status).toBe('unknown'); expect(r.rawParams).toBe(input.params);
  });
  it('matches canonical container ports and authored reset, distinct from turned macro value', () => {
    const input = node('group.container', { body, params: { spin: 0.8 } }), before = JSON.stringify(input);
    const r = resolveNodePresentation(registry, input);
    expect(r.inputs).toEqual(portsOf(input as never, 'in', k => DEF_BY_KIND.get(k)));
    expect(r.outputs).toEqual(portsOf(input as never, 'out', k => DEF_BY_KIND.get(k)));
    expect(r.parameters[0].spec.default).toBe(macroParams(input as never)[0].default);
    expect(r.parameters[0].reset).toEqual({ available: true, value: 0.5 });
    expect(r.parameters[0].resetSource).toBe('authored-macro'); expect(r.parameters[0].authoredMacroDefault).toBe(0.1);
    expect(r.parameters[0].base).toEqual({ available: true, value: macroValue(input as never, 'spin') });
    expect(JSON.stringify(input)).toBe(before);
    expect(resolveNodePresentation(registry, node('group.in'), { body }).outputs.map(p => p.key)).toEqual(['saved-in']);
    expect(resolveNodePresentation(registry, node('group.out'), { body }).inputs.map(p => p.key)).toEqual(['saved-out']);
  });
  it('keeps nested/unknown-version container interfaces but diagnoses unsupported execution', () => {
    const nested = { ...body, graph: { nodes: [...body.graph.nodes, node('group.container')], edges: [] } };
    const input = node('group.container', { body: nested }), before = JSON.stringify(input);
    const r = resolveNodePresentation(registry, input);
    expect(r.readOnly).toBe(true); expect(r.diagnostics).toContain('Nested containers are unsupported');
    expect(r.inputs[0].key).toBe('saved-in'); expect(JSON.stringify(input)).toBe(before);
    expect(resolveNodePresentation(registry, { ...input, defVersion: 99 }).inputs[0].key).toBe('saved-in');
    expect(resolveNodePresentation(registry, node('group.container')).diagnostics).toContain('Container interface unavailable or malformed');
  });
  it('container summary keeps signal position order, authored/canonical labels and excludes group sentinels', () => {
    const inner = { ...body, graph: { ...body.graph, nodes: [
      node('group.in', { id: 'gi', position: { x: -100, y: 0 } }),
      node('fx.hue-rotate', { id: 'hue', position: { x: 100, y: 0 } }),
      node('fx.feedback', { id: 'feedback', label: 'Authored feedback', position: { x: 20, y: 0 } }),
      node('future.kind', { id: 'future', position: { x: 200, y: 0 } }),
      node('group.out', { id: 'go', position: { x: 400, y: 0 } }),
    ] } };
    const before = JSON.stringify(inner);
    const r = resolveNodePresentation(registry, node('group.container', { body: inner }));
    expect(r.containerSummary).toEqual({ count: 3, labels: ['Authored feedback', 'Hue rotate', 'future.kind'] });
    expect(JSON.stringify(inner)).toBe(before);
  });
  it('malformed bodies and duplicate saved keys are diagnostic, never repaired', () => {
    for (const broken of [{ ...body, macros: [null] }, { ...body, ports: { in: [null], out: [] } }, { ...body, graph: { nodes: [null], edges: [] } }]) {
      const input = node('group.container', { body: broken as never }), before = JSON.stringify(input);
      expect(resolveNodePresentation(registry, input).readOnly).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
    }
    const duplicate = { ...body, ports: { ...body.ports, in: [...body.ports.in, ...body.ports.in] } };
    const r = resolveNodePresentation(registry, node('group.container', { body: duplicate }));
    expect(r.inputs).toHaveLength(2); expect(r.diagnostics).toContain('Duplicate saved in port key'); expect(r.readOnly).toBe(true);
  });
  it('a supplied invalid effective value is not accepted as evaluated truth', () => {
    expect(resolveNodePresentation(custom, n(), { effectiveValues: { amount: { available: true, value: null } } }).parameters[0].effective).toEqual({ available: false, reason: 'Invalid supplied effective value' });
  });
  it('compatibility requires exact section and definition sets and explicit IO evidence', () => {
    const receipt = { registrySourceCommit: registry.sourceCommit, ioSourceCommit: 'separately-tested-revision', sectionVersions: registry.sectionVersions,
      definitions: registry.definitions, fixtureEvidence: ['fixture-receipt-hash'] };
    expect(compatibilityProblems(registry, receipt)).toEqual([]);
    expect(compatibilityProblems(registry, { ...receipt, sectionVersions: { ...receipt.sectionVersions, graph: 99 } })).toContain('Project section versions differ');
    expect(compatibilityProblems(registry, { ...receipt, definitions: [] })).toContain('Definition version sets differ');
    expect(compatibilityProblems(registry, { ...receipt, fixtureEvidence: [] })).toContain('IO compatibility has no tested evidence');
  });
});


