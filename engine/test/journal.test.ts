import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Autosaver, apply, diff, recover } from '../src/project/journal';
import { saveProjectFile } from '../src/project/io';
import { newBlock, newProject, withChain } from '../src/project/build';
import type { ProjectDoc, SourceId } from '@moshpit/core';
import { mix32 } from '../src/util/determinism';

const start = (): ProjectDoc => {
  const d = newProject('journal');
  d.timeline.blocks = [withChain(newBlock('picture', 'S' as SourceId, 0, 90), [{ kind: 'fx.plane-desync' }, { kind: 'fx.feedback' }]), newBlock('motion', 'S' as SourceId, 10, 70)];
  return d;
};

/** A deterministic stream of the edits a session makes: drags, trims, added blocks, renamed things, deleted fields. */
function edit(d: ProjectDoc, i: number): ProjectDoc {
  const n = structuredClone(d), r = mix32(i * 7919 + 1);
  const b = n.timeline.blocks[r % n.timeline.blocks.length];
  switch (r % 5) {
    case 0: b.graph.nodes[0].position.x += 10; break;
    case 1: b.out = Math.max(b.in + 1, b.out - 1); break;
    case 2: n.timeline.blocks.push(newBlock('motion', 'S' as SourceId, 5, 50)); break;
    case 3: n.name = `journal ${i}`; break;
    default: { const pd = n.timeline.blocks[0].graph.nodes.find((x) => x.kind === 'fx.plane-desync'); if (pd) pd.params.dx = (r % 400) - 200; delete (n.view as Record<string, unknown>).activeBlock; }
  }
  return n;
}

describe('autosave journal (L14)', () => {
  it('diff/apply reproduces every edit in a 500-edit session', () => {
    let a = start();
    for (let i = 0; i < 500; i++) { const b = edit(a, i); expect(apply(a, diff(a, b))).toEqual(b); a = b; }
  });

  it('recovers the latest state after a crash, ignoring a torn last line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3j-')), file = path.join(dir, 'p.moshpit.json');
    let doc = start();
    saveProjectFile(file, doc);
    const a = new Autosaver(file, doc);
    let bytes = 0, written = 0;
    for (let i = 0; i < 200; i++) { doc = edit(doc, i); if (a.commit(doc) > 0) written++; } // an edit that changes nothing writes nothing
    bytes = fs.statSync(a.journal).size;
    fs.appendFileSync(a.journal, '{"seq":201,"d":[{"p":["na'); // the crash, mid-append
    const r = recover(file)!;
    expect(r.replayed).toBe(written);
    expect(r.tornTail).toBe(true);
    expect(r.doc).toEqual(doc);
    expect(bytes / written).toBeLessThan(2000); // a delta per edit, not a document
    fs.rmSync(dir, { recursive: true });
  });

  it('an explicit save starts a fresh journal; a journal for another save is not replayed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3j-')), file = path.join(dir, 'p.moshpit.json');
    let doc = start();
    saveProjectFile(file, doc);
    const a = new Autosaver(file, doc);
    doc = edit(doc, 1); a.commit(doc);
    a.save(doc);
    // Phase 0.3: the fresh header went through a temp file and a rename, leaving no temp behind.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.readFileSync(a.journal, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(recover(file)).toMatchObject({ replayed: 0, stale: false });
    doc = edit(doc, 2); a.commit(doc);
    saveProjectFile(file, edit(doc, 3)); // saved elsewhere, behind this journal's back
    expect(recover(file)).toMatchObject({ replayed: 0, stale: true });
    fs.rmSync(dir, { recursive: true });
  });
});
