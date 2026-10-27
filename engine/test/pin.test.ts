// A-2: the runtime is the reproducibility baseline. Chromium does the decode, the GPU maths and
// (with mediabunny / mp4box) the bitstream, so these are exact pins, and what is installed must be
// what is pinned. Upgrade policy: README, "Runtime pin".
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const json = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const PINNED = ['electron', 'mediabunny', 'mp4box'];

describe('runtime pin (A-2)', () => {
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  for (const name of PINNED) {
    it(`${name} is an exact version, and the lockfile and install agree`, () => {
      const want = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];
      expect(want).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${name}`].version).toBe(want);
      expect(json(`node_modules/${name}/package.json`).version).toBe(want);
    });
  }
  it('the packager is pinned too', () => {
    expect(fs.readFileSync(path.join(root, 'app', 'pack.mjs'), 'utf8')).toMatch(/electron-builder@\d+\.\d+\.\d+'/);
  });
});
