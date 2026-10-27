// R-2 (readiness audit): a history op's VRAM is estimated from its real ring depth (echo taps:
// taps × spacing, up to 48 frames, not a flat 20), and running out of budget names the effect and
// the knob to turn down, freeing what the ring had already allocated.
import { describe, expect, it } from 'vitest';
import { MoshpitError } from '../src/errors';
import { historyFrames, TEMPORAL_OPS } from '../src/nodes/ops/temporal';
import { HistoryNode } from '../src/gpu/ops';
import { compileBlockGraph } from '../src/graph/stage2';
import { newBlock, withChain } from '../src/project/build';
import type { SourceId } from '../src/model';

const echo = TEMPORAL_OPS.find((o) => o.def.kind === 'fx.echo-taps')!;

describe('history VRAM (R-2)', () => {
  it('echo taps holds taps × spacing frames, plus its pass target', () => {
    expect(historyFrames('fx.echo-taps', { taps: 4, spacing: 12 })).toBe(49);
    expect(historyFrames('fx.echo-taps', { taps: 3, spacing: 4 })).toBe(13);
    expect(historyFrames('fx.posterize', {})).toBeUndefined();
  });

  it("the block plan's working-frame estimate follows the params", () => {
    const plan = (taps: number, spacing: number) => { const b = withChain(newBlock('motion', 'S' as SourceId, 1, 60), [{ kind: 'fx.echo-taps', params: { taps, spacing } }]); return compileBlockGraph(b.id, b.graph).workingFrames; };
    expect(plan(4, 12) - plan(3, 4)).toBe(49 - 13);
  });

  it('over budget: a named, actionable error, and nothing left allocated', () => {
    let live = 0;
    const be = {
      program: () => ({}),
      target: () => { if (live >= 10) throw new MoshpitError('GPU_VRAM_EXCEEDED', { purpose: 'test' }); live++; return {}; },
      release: () => { live--; },
    };
    let err: MoshpitError | undefined;
    try { new HistoryNode(echo.def, echo.shader!, echo.history, { amount: 60, taps: 4, spacing: 12, decay: 60, wet: 1 }, be as never, 1920, 1080); } catch (e) { err = e as MoshpitError; }
    expect(err?.code).toBe('GPU_VRAM_EXCEEDED');
    expect(err?.humanMessage).toMatch(/Echo taps keeps 49 frames of history .* Lower its taps or spacing/);
    expect(live).toBe(0);
  });
});
