// Source checks and web preview share the same E-only child environment as builds.
import { ensureScratch, configureToolCaches } from './build-scratch/bootstrap.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const scratch = ensureScratch('build');
configureToolCaches(scratch);
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const tool = process.argv[2];
const pkgName = { vitest: 'vitest', tsc: 'typescript', vite: 'vite' }[tool];
if (!pkgName) throw new Error('Expected vitest, tsc or vite.');
const pkgFile = require.resolve(`${pkgName}/package.json`);
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const cli = path.resolve(path.dirname(pkgFile), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[tool]);
process.env.MOSHPIT_VITE_CACHE = path.join(scratch.temp, 'vite-app');
process.env.MOSHPIT_BUILD_OUT = path.join(scratch.artifacts, 'app-dist');
execFileSync(process.execPath, [cli, ...process.argv.slice(3)], { cwd: root, stdio: 'inherit', windowsHide: true });
