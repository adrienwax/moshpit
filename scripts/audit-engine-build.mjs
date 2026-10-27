import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const entry = process.env.AUDIT_ENGINE_ENTRY || 'audit-engine';
if (!['audit-engine', 'audit-hd60'].includes(entry)) throw new Error('Unknown isolated audit entry');
const out = path.resolve(process.env.AUDIT_ENGINE_OUT || '');
const base = path.join(root, 'out', 'audit-engine');
if (!out.startsWith(base + path.sep)) throw new Error('AUDIT_ENGINE_OUT must be a fresh child of out/audit-engine');
if (fs.existsSync(out)) throw new Error('Refusing an existing audit output directory');
fs.mkdirSync(out, { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: [path.join(root, `harness/src/${entry}.ts`)], outfile: path.join(out, 'runner.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'chrome150', external: ['electron'], sourcemap: true, metafile: true,
  alias: { '@moshpit/core': path.join(root, 'core/src/index.ts'), '@moshpit/engine': path.join(root, 'engine/src/index.ts') },
});
const inputs = Object.keys(result.metafile.inputs).map(p => path.resolve(root, p));
const foreignSource = inputs.filter(p => /[\\/]moshpit-v3[\\/](engine|core)[\\/]src[\\/]/i.test(p) && !p.startsWith(root + path.sep));
if (foreignSource.length) throw new Error('Foreign workspace source: ' + foreignSource.join(', '));
const source = inputs.filter(p => p.startsWith(root + path.sep) && !p.includes(`${path.sep}node_modules${path.sep}`)).map(p => ({ file: path.relative(root, p), sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }));
fs.writeFileSync(path.join(out, 'build-inputs.json'), JSON.stringify({ root, entry, source, foreignSource, inputs }, null, 2));
fs.writeFileSync(path.join(out, 'runner.html'), '<!doctype html><meta charset="utf-8"><title>Isolated engine audit</title><script>require("./runner.cjs")</script>');
console.log(JSON.stringify({ out, sourceFiles: source.length, foreignSource: foreignSource.length }));
