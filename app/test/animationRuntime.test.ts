// Shared parameter-compiler/evaluator parity only. No GPU, media decoding,
// native playback or native export is exercised by this suite.
import { describe, expect, it, vi } from 'vitest';
import type { NodeInstance, ProjectDoc, Rational, SourceId } from '@moshpit/core';
import { compileParams, resolveInto } from '../../engine/src/control/params';
import { RationalClock } from '../../engine/src/time/clock';
import { DEF_BY_KIND } from '../../engine/src/nodes/defs';
import { newBlock, newNode, newProject, withChain } from '../../engine/src/project/build';
import { parseProject, serializeProject } from '../../engine/src/project/io';
import { enableEnvelope, evaluateEnvelope, readEnvelope, type Envelope } from '../src/lib/parameterEnvelope';
import { changeEnvelope, envelopeParams } from '../src/state/animation';

const state = vi.hoisted(() => ({ doc: null as unknown as ProjectDoc, commit: vi.fn() }));
vi.mock('../src/engine', async () => {
  const { DEF_BY_KIND } = await import('../../engine/src/nodes/defs');
  return { defOf: (kind: string) => DEF_BY_KIND.get(kind) };
});
vi.mock('../src/state/project', () => ({
  getDoc: () => state.doc, commit: state.commit, isFrozen: () => false,
  nodesOf: (block: { graph: { nodes: NodeInstance[] } }) => block.graph.nodes, selectNode: vi.fn(),
}));
vi.mock('../src/state/ui', () => ({ setUi: vi.fn() }));
vi.mock('../src/layout/model', () => ({ DEFAULT_LAYOUTS: {}, layoutStore: {}, setWsLayout: vi.fn() }));

const rates: Rational[] = [{ num: 60, den: 1 }, { num: 24000, den: 1001 }];
function at(node: NodeInstance, key: string, fps: Rational, frames: number[]) {
  const def = DEF_BY_KIND.get(node.kind)!, clock = new RationalClock(fps);
  const progs = compileParams(def.params, node, [], clock, 120);
  const index = def.params.findIndex(param => param.key === key), out = new Float32Array(1);
  return frames.map(frame => { resolveInto(progs[index], frame, out, 0); return out[0]; });
}
function envelope(fps: Rational, key: 'degrees' | 'wet', ease: Envelope['ease']): Envelope {
  const clock = new RationalClock(fps);
  return { version: 1, start: clock.seconds(60), end: clock.seconds(180), from: key === 'degrees' ? 170 : 0.1,
    to: key === 'degrees' ? -170 : 0.9, ease, hue: key === 'degrees' ? 'shortest' : 'direct' };
}

describe.each(rates)('authored animation through shared runtime at $num/$den fps', fps => {
  it.each(['linear', 'in', 'out', 'smooth'] as const)('resolves actual hue and wet definitions using %s easing in arbitrary seek order', ease => {
    for (const key of ['degrees', 'wet'] as const) {
      const node = newNode('fx.hue-rotate'), env = envelope(fps, key, ease);
      node.bindings[key] = enableEnvelope(undefined, env);
      const frames = [0, 59, 60, 61, 90, 120, 150, 179, 180, 181, 240];
      const resolved = at(node, key, fps, frames);
      // resolveInto derives seconds as frame * secondsPerFrame, then writes Float32.
      // Do not mistake float32 quantization for a difference in envelope mathematics.
      const expected = frames.map(frame => Math.fround(evaluateEnvelope(env, frame * (fps.den / fps.num))));
      expect(resolved).toEqual(expected);
      expect(resolved[0]).toBe(Math.fround(env.from));
      expect(resolved.at(-1)).toBe(Math.fround(env.to));
      const shuffled = [180, 61, 0, 150, 60, 240, 120, 59, 90, 181, 179];
      expect(at(node, key, fps, shuffled)).toEqual(shuffled.map(frame => resolved[frames.indexOf(frame)]));
    }
  });

  it('wraps the shortest hue before the real parameter clamp, retaining the negative side of the wheel', () => {
    const node = newNode('fx.hue-rotate'), env = envelope(fps, 'degrees', 'linear');
    node.bindings.degrees = enableEnvelope(undefined, env);
    const def = DEF_BY_KIND.get(node.kind)!.params.find(param => param.key === 'degrees')!;
    expect([def.min, def.max]).toEqual([-180, 180]);
    expect(at(node, 'degrees', fps, [60, 90, 120, 150, 180])).toEqual([170, 175, -180, -175, -170]);
    // An unwrapped 170→190 expression would clamp these last values to +180.
    expect(at(node, 'degrees', fps, [150, 180]).every(value => value < 0)).toBe(true);
    node.bindings.degrees = enableEnvelope(undefined, { ...env, from: -170, to: 170 });
    expect(at(node, 'degrees', fps, [60, 90, 120, 150, 180])).toEqual([-170, -175, -180, 175, 170]);
  });

  it('serializes and parses the project without changing envelope metadata or runtime samples', () => {
    const doc = newProject('Envelope evaluation fixture', { fps });
    const block = withChain(newBlock('picture', 'synthetic-source-id' as SourceId, 0, 300), [{ kind: 'fx.hue-rotate' }]);
    const node = block.graph.nodes.find(candidate => candidate.kind === 'fx.hue-rotate')!;
    node.bindings.degrees = enableEnvelope({ expression: { source: 'base+3', op: 'add' }, future: { original: true } }, envelope(fps, 'degrees', 'smooth'));
    node.bindings.wet = enableEnvelope(undefined, envelope(fps, 'wet', 'out'));
    doc.timeline.blocks = [block];
    const serialized = serializeProject(doc), loaded = parseProject(serialized).doc;
    expect(serializeProject(loaded)).toBe(serialized);
    const restored = loaded.timeline.blocks[0].graph.nodes.find(candidate => candidate.id === node.id)!;
    for (const key of ['degrees', 'wet'] as const) {
      expect(readEnvelope(restored.bindings[key])).toEqual(readEnvelope(node.bindings[key]));
      expect(restored.bindings[key]).toEqual(node.bindings[key]);
      const frames = [299, 60, 0, 180, 120, 59, 181, 61];
      expect(at(restored, key, loaded.settings.fps, frames)).toEqual(at(node, key, fps, frames));
    }
  });
});

describe('authored animation parameter eligibility', () => {
  it('exposes hue/wet continuous parameters and rejects a discrete channel through the state command', () => {
    const hue = newNode('fx.hue-rotate');
    expect(envelopeParams(hue).map(param => param.key)).toEqual(['degrees', 'wet']);
    const discrete = newNode('fx.plane-desync');
    expect(envelopeParams(discrete).map(param => param.key)).not.toContain('channel');
    const doc = newProject('Unsupported discrete animation'), block = newBlock('picture', 'source' as SourceId, 0, 300);
    block.graph.nodes.push(discrete); doc.timeline.blocks = [block]; state.doc = doc; state.commit.mockClear();
    const before = JSON.stringify(doc);
    expect(() => changeEnvelope(block.id, discrete.id, 'channel', envelope(rates[0], 'wet', 'linear'), true)).toThrow(/not available/);
    expect(state.commit).not.toHaveBeenCalled(); expect(JSON.stringify(doc)).toBe(before);
    // Even an externally supplied expression cannot animate a non-modulatable enum.
    discrete.bindings.channel = enableEnvelope(undefined, envelope(rates[0], 'wet', 'linear'));
    const def = DEF_BY_KIND.get(discrete.kind)!, index = def.params.findIndex(param => param.key === 'channel');
    const compiled = compileParams(def.params, discrete, [], new RationalClock(rates[0]), 120);
    expect(compiled[index].expr).toBeNull();
    const values = at(discrete, 'channel', rates[0], [0, 60, 120, 180, 240]);
    expect(new Set(values).size).toBe(1);
  });
});
