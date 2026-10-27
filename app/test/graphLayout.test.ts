import { describe, expect, it } from 'vitest';
import { organise } from '../src/lib/graphLayout';

const at = (r: ReturnType<typeof organise>, id: string) => r.find((n) => n.id === id)!;

describe('organise', () => {
  it('puts each node one column right of its deepest input', () => {
    const r = organise(
      [{ id: 'src', x: 500, y: 0 }, { id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 50 }, { id: 'mix', x: 0, y: 0 }, { id: 'out', x: 0, y: 0 }],
      [{ from: 'src', to: 'a' }, { from: 'a', to: 'b' }, { from: 'src', to: 'mix' }, { from: 'b', to: 'mix' }, { from: 'mix', to: 'out' }],
    );
    expect([at(r, 'src').x, at(r, 'a').x, at(r, 'b').x, at(r, 'mix').x, at(r, 'out').x]).toEqual([0, 230, 460, 690, 920]);
  });

  it('stacks parallel branches and survives a Delay loop', () => {
    const r = organise(
      [{ id: 's', x: 0, y: 0 }, { id: 'top', x: 0, y: 0 }, { id: 'bot', x: 0, y: 100 }, { id: 'd', x: 0, y: 0, isDelay: true }],
      [{ from: 's', to: 'top' }, { from: 's', to: 'bot' }, { from: 'top', to: 'd' }, { from: 'd', to: 'top' }],
    );
    expect(at(r, 'top').x).toBe(at(r, 'bot').x);
    expect(at(r, 'top').y).toBeLessThan(at(r, 'bot').y);
    expect(at(r, 'd').x).toBeGreaterThan(at(r, 'top').x);
  });
});
