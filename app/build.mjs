// App build + dev runner.
//   node app/build.mjs        → unique E-drive run/artifacts/app-dist
//   node app/build.mjs dev    → Vite dev server on :5174 + Electron pointed at it
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureScratch, configureToolCaches, requireScratchOutput } from '../scripts/build-scratch/bootstrap.mjs';

const scratch = ensureScratch('build');
configureToolCaches(scratch);
const { build: esbuild } = await import('esbuild');
const { build: viteBuild, createServer } = await import('vite');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dev = process.argv[2] === 'dev';
const mode = process.argv[2];
const outdir = requireScratchOutput(process.env.MOSHPIT_BUILD_OUT ?? path.join(scratch.artifacts, 'app-dist'));
if (!outdir.toLowerCase().startsWith(scratch.artifacts.toLowerCase() + path.sep)) throw new Error('MOSHPIT_BUILD_OUT must be inside this run\'s artifacts directory.');
process.env.MOSHPIT_BUILD_OUT = outdir;
process.env.MOSHPIT_VITE_CACHE = path.join(scratch.temp, 'vite-app');

await esbuild({
  entryPoints: { main: path.join(here, 'electron/main.ts'), preload: path.join(here, 'electron/preload.ts'), worker: path.join(here, 'electron/worker.ts'), jobs: path.join(here, 'electron/jobs-process.ts') },
  outdir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // Workspace dependencies can be junctions to an older checkout. Always compile
  // this checkout's engine/core; never silently follow those workspace links.
  alias: { '@moshpit/core': path.join(root, 'core/src/index.ts'), '@moshpit/engine': path.join(root, 'engine/src/index.ts') },
  external: ['electron'],
  logLevel: 'warning',
});


if (!dev) {
  await viteBuild({ configFile: path.join(here, 'vite.config.mts'), configLoader: 'runner' });
  const git = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
  const commit = git(['rev-parse', 'HEAD']) || 'unknown';
  const dirty = !!git(['status', '--porcelain', '--', 'app', 'core', 'engine', 'package.json', 'package-lock.json']);
  fs.writeFileSync(path.join(outdir, 'build-info.json'), JSON.stringify({ version, commit, dirty, built: new Date().toISOString() }, null, 2) + '\n');
  console.log(`App build: ${outdir}`);
  if (mode === 'start') {
    const electron = createRequire(import.meta.url)('electron');
    execFileSync(electron, [path.join(outdir, 'main.cjs')], { stdio: 'inherit', windowsHide: true });
  } else if (mode === 'e2e') {
    execFileSync(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(3)], { cwd: root, stdio: 'inherit', windowsHide: true });
  }
  // No display face is copied in: the design system dropped Averox (and its personal-use licence)
  // for Inter + JetBrains Mono, which ship bundled from @fontsource-variable.
} else {
  const server = await createServer({ configFile: path.join(here, 'vite.config.mts'), configLoader: 'runner' });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`renderer: ${url}`);
  const electron = createRequire(import.meta.url)('electron');
  const child = spawn(electron, [path.join(outdir, 'main.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, MOSHPIT_DEV_URL: url },
  });
  child.on('exit', async (code) => {
    await server.close();
    process.exit(code ?? 0);
  });
}
