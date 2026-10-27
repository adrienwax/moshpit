// R-1 (readiness audit): service.setParam patches its snapshot without a recompile for params
// read at render time, and falls back to a full update (a version bump) for encoded-stream ops,
// whose params are compiled into the plan. The live-engine side is proven in app fullloop (pixels).
import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineService } from '../src/service/service';
import { NODE_DEFS } from '../src/nodes/defs';
import { newBlock, newNode, newProject } from '../src/project/build';
import type { SourceId } from '../src/model';

const numeric = (d: (typeof NODE_DEFS)[number]) => d.params.find((p) => typeof p.default === 'number' && p.min !== undefined && p.max !== undefined);
const frameFx = NODE_DEFS.find((d) => d.domain !== 'ENCODED_STREAM' && d.category === 'Effect' && numeric(d))!;
const encodedOp = NODE_DEFS.find((d) => d.domain === 'ENCODED_STREAM' && d.category === 'Mosh' && numeric(d))!;

function setup() {
  const svc = new EngineService({ cacheDir: path.join(os.tmpdir(), 'mp3-paramfast') });
  const doc = newProject('pf');
  const b = newBlock('picture', 'src-x' as SourceId, 0, 10);
  const fx = newNode(frameFx.kind), op = newNode(encodedOp.kind);
  b.graph.nodes.push(fx, op);
  doc.timeline.blocks = [b];
  svc.updateProject(doc);
  const version = () => (svc as unknown as { version: number }).version;
  return { svc, b, fx, op, version };
}

describe('service.setParam (R-1)', () => {
  it(`a render-time param (${frameFx.kind}) patches the snapshot with no recompile`, () => {
    const { svc, b, fx, version } = setup();
    const p = numeric(frameFx)!, v0 = version(), before = (svc as unknown as { doc: unknown }).doc;
    svc.setParam(b.id, fx.id, p.key, p.max!);
    const doc = (svc as unknown as { doc: { timeline: { blocks: typeof b[] } } }).doc;
    expect(doc.timeline.blocks[0].graph.nodes.find((n) => n.id === fx.id)!.params[p.key]).toBe(p.max);
    expect(version()).toBe(v0);
    expect(svc.fastParams).toBe(1);
    expect(doc).not.toBe(before); // a new snapshot, the old one untouched (undo shares it)
  });

  it(`an encoded-stream op's param (${encodedOp.kind}) takes the full path`, () => {
    const { svc, b, op, version } = setup();
    const p = numeric(encodedOp)!, v0 = version();
    svc.setParam(b.id, op.id, p.key, p.max!);
    expect(version()).toBe(v0 + 1);
    expect(svc.fastParams).toBe(0);
  });

  it('an unknown node is refused, not silently dropped', () => {
    const { svc, b } = setup();
    expect(() => svc.setParam(b.id, 'nope' as never, 'x', 1)).toThrow();
  });

  it('a history op (its depth sizes the VRAM estimate) takes the full path', () => {
    const { svc, b, version } = setup();
    const echo = newNode('fx.echo-taps');
    (svc as unknown as { doc: { timeline: { blocks: { graph: { nodes: unknown[] } }[] } } }).doc.timeline.blocks[0].graph.nodes.push(echo);
    const v0 = version();
    svc.setParam(b.id, echo.id, 'taps', 4);
    expect(version()).toBe(v0 + 1);
  });
});
