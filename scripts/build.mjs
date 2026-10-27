// One build for every non-UI bundle: the harness runner, the Electron main process, the preload
// and the render worker. All are CommonJS for Electron's Node side; the engine is bundled in
// (TypeScript straight from engine/src), node builtins and electron stay external.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'chrome150', sourcemap: 'linked', external: ['electron'], logLevel: 'warning' };

// The app (main, preload, renderer) is built by app/build.mjs, owned by the UI lane.
const entries = [
  { in: 'harness/src/runner.ts', out: 'harness/dist/runner.cjs' },
];

const builds = entries.filter((e) => !e.optional || fs.existsSync(path.join(root, e.in)));
const ctxs = await Promise.all(builds.map((e) => esbuild.context({ ...common, entryPoints: [path.join(root, e.in)], outfile: path.join(root, e.out) })));
if (watch) {
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log(`watching ${builds.length} bundles`);
} else {
  await Promise.all(ctxs.map((c) => c.rebuild()));
  await Promise.all(ctxs.map((c) => c.dispose()));
  console.log(`built ${builds.map((b) => b.out).join(', ')}`);
}
