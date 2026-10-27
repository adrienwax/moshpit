import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lanesFor, mirrorWav, wavHeader, RAMP, type Lane } from '../src/audio/mirror';
import { newBlock, withChain } from '../src/project/build';
import type { BlockSpan } from '../src/timeline/stage1';
import type { SourceId } from '@moshpit/core';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3mir-'));
const RATE = 48000, N = RATE * 4;

/** A stereo test signal: a 440 Hz tone with a slow chirp on the right, written as 16-bit WAV. */
function testWav(file: string): void {
  const data = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.5 * 32767), i * 4);
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (200 + i / 200) * i) / RATE) * 0.5 * 32767), i * 4 + 2);
  }
  fs.writeFileSync(file, Buffer.concat([wavHeader(2, RATE, data.length), data]));
}
const IN = path.join(dir, 'in.wav');
testWav(IN);
const run = (lanes: Lane[], chunk = 48000, name = 'out.wav') => { const f = path.join(dir, name); mirrorWav(IN, f, lanes, 120, chunk); return fs.readFileSync(f); };
const ALL: Lane[] = [{ send: 'gate', start: 24000, end: 96000, amount: 1 }, { send: 'crush', start: 72000, end: 150000, amount: 0.7 }, { send: 'filter', start: 0, end: N, amount: 0.5 }];

describe('audio mirror MVP (M5)', () => {
  it('is bit-exact dry when no send is on', () => {
    expect(run([]).equals(fs.readFileSync(IN))).toBe(true);
  });

  it('changes only the lane (plus its 10 ms ramps)', () => {
    const out = run([{ send: 'gate', start: 48000, end: 96000, amount: 1 }]), inp = fs.readFileSync(IN);
    // Both channels: the left 440 Hz tone is exactly periodic over a 16th note at 120 BPM (6,000 samples
    // = 55 cycles), so a repeated slice of it is sample-identical; the right channel's chirp is not.
    const at = (b: Buffer, i: number) => b.readInt32LE(44 + i * 4);
    let outside = 0, inside = 0;
    for (let i = 0; i < N; i++) {
      const d = at(out, i) !== at(inp, i);
      if (i < 48000 - RAMP || i >= 96000 + RAMP) { if (d) outside++; } else if (d) inside++;
    }
    expect(outside).toBe(0);
    expect(inside).toBeGreaterThan(20000);
  });

  it('is deterministic and independent of the chunk size (streaming state is exact)', () => {
    const a = run(ALL, 48000, 'a.wav'), b = run(ALL, 4096, 'b.wav'), c = run(ALL, 1000, 'c.wav'), d = run(ALL, 48000, 'd.wav');
    expect(a.equals(d)).toBe(true);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(true);
  });

  it('crushes to 4-bit levels where the bitcrusher is fully wet', () => {
    const out = run([{ send: 'crush', start: 24000, end: 72000, amount: 1 }]);
    const levels = new Set<number>();
    for (let i = 30000; i < 60000; i++) levels.add(out.readInt16LE(44 + i * 4));
    expect(levels.size).toBeLessThanOrEqual(17);
  });

  it('maps families to sends per block repetition: motion → gate, Degrade → crush, Tone → filter', () => {
    const S = 'S' as SourceId;
    const blocks = [
      withChain(newBlock('picture', S, 0, 30), [{ kind: 'fx.posterize' }]),           // Tone → filter
      withChain(newBlock('motion', S, 1, 31), [{ kind: 'fx.salt-pepper' }]),          // motion → gate, Degrade → crush
      withChain(newBlock('picture', S, 0, 30), [{ kind: 'fx.soft-blur' }], ),          // Degrade, but bypassed below
      newBlock('motion', S, 1, 31, { audio: { mute: true } }),                        // muted: nothing
      newBlock('motion', S, 1, 31, { audio: { mute: false, mirror: 0 } }),            // mirror 0: nothing
    ];
    blocks[2].graph.nodes.find((n) => n.kind === 'fx.soft-blur')!.bypass = true;
    const spans: BlockSpan[] = blocks.map((b, i) => ({ blockId: b.id, kind: b.kind, start: i * 30, end: i * 30 + 30, repetition: 0 }));
    const lanes = lanesFor(spans, blocks, { num: 30, den: 1 }, RATE);
    expect(lanes.map((l) => [l.send, l.start, l.end])).toEqual([['filter', 0, 48000], ['gate', 48000, 96000], ['crush', 48000, 96000]]);
  });
});
