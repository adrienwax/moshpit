// Phase 1.4: utility nodes compile where they belong. The pixels are checked on the GPU in
// e2e/app.spec.ts (Mix modes, Switch, Reroute / Null).
import { describe, expect, it } from 'vitest';
import type { SourceId } from '@moshpit/core';
import { compileBlockGraph } from '../src/graph/stage2';
import { graphHash } from '../src/runtime/freeze';
import { newBlock, withChain } from '../src/project/build';
import { DEF_BY_KIND, isPlaceable } from '../src/nodes/defs';

const S = 'S' as SourceId;
const UTIL = ['route.reroute', 'route.reroute-stream', 'route.null', 'route.switch'];

describe('utility nodes (Phase 1.4)', () => {
  it('exist, are Routing, are placeable', () => {
    for (const k of UTIL) {
      const d = DEF_BY_KIND.get(k);
      expect(d?.category, k).toBe('Routing');
      expect(isPlaceable(d!), k).toBe(true);
    }
  });

  it('each compiles in a chain (the stream Reroute before the Decode, the rest after)', () => {
    for (const k of UTIL) {
      const b = withChain(newBlock('motion', S, 0, 60), [{ kind: 'mosh.hold' }, { kind: k }, { kind: 'fx.invert' }]);
      // withChain wires each node's 'in'; Switch's inputs are A–D, like Mix's.
      for (const e of b.graph.edges) if (b.graph.nodes.find((x) => x.id === e.to.node)?.kind === 'route.switch') e.to = { ...e.to, port: 'a' as never };
      expect(compileBlockGraph(b.id, b.graph).errors.map((e) => e.code), k).toEqual([]);
    }
  });

  it('the stream Reroute is identity in the encoded chain: same encoded ops as without it', () => {
    const a = withChain(newBlock('motion', S, 0, 60), [{ kind: 'mosh.hold' }, { kind: 'mosh.stride' }]);
    const z = withChain(newBlock('motion', S, 0, 60), [{ kind: 'mosh.hold' }, { kind: 'route.reroute-stream' }, { kind: 'mosh.stride' }]);
    expect(compileBlockGraph(z.id, z.graph).encodedOps).toEqual(compileBlockGraph(a.id, a.graph).encodedOps);
  });

  it("Mix's mode is a param: it defaults to the old cross-fade and changes the freeze key", () => {
    const mix = DEF_BY_KIND.get('route.mix')!;
    expect(mix.params.find((p) => p.key === 'mode')?.default).toBe('mix');
    const b = withChain(newBlock('picture', S, 0, 30), [{ kind: 'route.mix' }]);
    const m = b.graph.nodes.find((n) => n.kind === 'route.mix')!;
    const h0 = graphHash(b, []);
    m.params.mode = 'difference';
    expect(graphHash(b, [])).not.toBe(h0);
  });
});
