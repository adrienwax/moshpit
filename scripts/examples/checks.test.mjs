import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { sourceFrame, WIDTH, HEIGHT } from './sources.mjs';
import { checkPack } from './check-pack.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('authored footage is deterministic, moving and visually distinct', () => {
  const a = sourceFrame('ribbons', 0), b = sourceFrame('ribbons', 30), c = sourceFrame('orbit', 0);
  assert.equal(a.length, WIDTH * HEIGHT * 3);
  assert.equal(hash(a), hash(sourceFrame('ribbons', 0)));
  assert.notEqual(hash(a), hash(b)); assert.notEqual(hash(a), hash(c));
  assert.throws(() => sourceFrame('unknown', 0));
});
test('pack validator checks references, hashes and private paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moshpit-pack-check-'));
  try {
    const project = JSON.stringify({ source: 'pack://clip.mp4' }); fs.writeFileSync(path.join(root, 'one.mosh'), project); fs.writeFileSync(path.join(root, 'clip.mp4'), 'fixture');
    const manifest = { schemaVersion: 1, packId: 'test', files: [{ path: 'one.mosh', sha256: hash(project) }, { path: 'clip.mp4', sha256: hash('fixture') }], examples: Array.from({ length: 4 }, (_, i) => ({ id: `example-${i}`, title: 'Example', group: 'mix', hint: 'Change amount', seconds: 8, file: 'one.mosh', preview: 'clip.mp4' })) };
    const write = () => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    write(); assert.equal(checkPack(root).status, 'PASS');
    manifest.files[0].path = '../one.mosh'; write(); assert.throws(() => checkPack(root), /path/);
    manifest.files[0].path = 'one.mosh'; fs.writeFileSync(path.join(root, 'one.mosh'), '{}'); write(); assert.throws(() => checkPack(root), /hash/);
    const privateDoc = JSON.stringify({ source: 'C:\\Users\\private\\clip.mp4' }); fs.writeFileSync(path.join(root, 'one.mosh'), privateDoc); manifest.files[0].sha256 = hash(privateDoc); write(); assert.throws(() => checkPack(root), /absolute/);
    const missing = JSON.stringify({ source: 'pack://missing.mp4' }); fs.writeFileSync(path.join(root, 'one.mosh'), missing); manifest.files[0].sha256 = hash(missing); write(); assert.throws(() => checkPack(root), /Unresolved/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
