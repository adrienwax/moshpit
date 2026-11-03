// Bundled examples become durable user-data assets before the UI receives paths.
// Saved copies must never refer to a portable EXE's temporary extraction directory.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseExamples, type ExampleProject } from '../src/lib/exampleProjects';

type Pack = { schemaVersion: 1; packId: string; files: { path: string; sha256: string }[]; examples: ExampleProject[] };
type Catalog = { schemaVersion: 1; examples: ExampleProject[]; warning?: string };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pathKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (root: string, file: string) => { const r = path.relative(root, file); return !!r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };

export function packPath(root: string, name: string): string {
  // Forward-slash portable names only; reject Windows aliases/streams on every OS.
  if (typeof name !== 'string' || name.length > 240 || !name.split('/').every(p => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(p) && !p.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw Error('Invalid example asset path');
  const file = path.resolve(root, name);
  if (!inside(path.resolve(root), file)) throw Error('Example path escapes pack');
  return file;
}

async function bytesAt(root: string, name: string): Promise<Buffer> {
  const file = packPath(root, name);
  const actual = await fs.realpath(file);
  if (!inside(await fs.realpath(root), actual)) throw Error('Example asset escapes its pack');
  const stat = await fs.stat(actual);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error('Example asset is too large');
  return fs.readFile(actual);
}

function relocate(value: unknown, target: string, names: Set<string>): unknown {
  if (typeof value === 'string' && value.startsWith('pack://')) {
    const name = value.slice(7);
    if (!names.has(name)) throw Error('Project references an unlisted example asset');
    return packPath(target, name);
  }
  if (Array.isArray(value)) return value.map(x => relocate(x, target, names));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relocate(v, target, names)]));
  return value;
}

export async function installExamplePack(packRoot: string, userData: string): Promise<ExampleProject[]> {
  const manifestBytes = await bytesAt(packRoot, 'manifest.json');
  if (manifestBytes.length > 256 * 1024) throw Error('Example manifest is too large');
  const pack = JSON.parse(manifestBytes.toString('utf8')) as Pack;
  if (pack.schemaVersion !== 1 || !/^[a-z0-9-]{1,60}$/.test(pack.packId) || !Array.isArray(pack.files) || pack.files.length < 1 || pack.files.length > 128 || !Array.isArray(pack.examples) || pack.examples.length > 32) throw Error('Invalid example manifest');
  const names = new Set<string>();
  for (const file of pack.files) {
    packPath(packRoot, file.path);
    if (names.has(file.path.toLowerCase()) || file.path === 'manifest.json' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid example asset pin');
    names.add(file.path.toLowerCase());
  }
  const exactNames = new Set(pack.files.map(f => f.path));
  const parent = path.join(userData, 'examples', 'packs');
  await fs.mkdir(parent, { recursive: true });
  const target = path.join(parent, digest(manifestBytes));
  const examples = parseExamples({ schemaVersion: 1, examples: pack.examples.map(row => {
    if (!row.id.startsWith('starter-') || !exactNames.has(row.file) || !row.preview || !exactNames.has(row.preview)) throw Error('Invalid bundled example entry');
    return { ...row, file: packPath(target, row.file), preview: packPath(target, row.preview), collection: 'bundled' };
  }) });
  const assets: { name: string; bytes: Buffer }[] = [];
  let total = 0;
  for (const file of pack.files) {
    let bytes = await bytesAt(packRoot, file.path);
    total += bytes.length;
    if (total > 200 * 1024 * 1024 || digest(bytes) !== file.sha256) throw Error('Example asset check failed');
    if (/\.(mosh|json)$/i.test(file.path)) bytes = Buffer.from(JSON.stringify(relocate(JSON.parse(bytes.toString('utf8')), target, exactNames)) + '\n');
    assets.push({ name: file.path, bytes });
  }
  async function verifyInstalled() {
    for (const asset of assets) {
      const bytes = await bytesAt(target, asset.name);
      if (digest(bytes) !== digest(asset.bytes)) throw Error('Installed example asset changed');
    }
  }
  try { await fs.access(target); await verifyInstalled(); return examples; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Only create a new pack. Existing edited/damaged packs are never overwritten.
  const staging = path.join(parent, '.install-' + randomUUID());
  await fs.mkdir(staging);
  try {
    for (const asset of assets) {
      const file = packPath(staging, asset.name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, asset.bytes, { flag: 'wx' });
    }
    try { await fs.rename(staging, target); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      await verifyInstalled();
    }
  } finally {
    if (inside(parent, staging) && path.basename(staging).startsWith('.install-')) await fs.rm(staging, { recursive: true, force: true });
  }
  return examples;
}

export function createExampleLibrary(packRoot: string, userData: string) {
  let bundled: Promise<ExampleProject[]> | undefined;
  const allowed = new Map<string, string>();
  return {
    async read(): Promise<Catalog> {
      const warnings: string[] = [];
      bundled ??= installExamplePack(packRoot, userData);
      const built = await bundled.catch(() => { bundled = undefined; warnings.push('Built-in examples are unavailable. Your saved projects are unchanged.'); return []; });
      let local: ExampleProject[] = [];
      try {
        const file = path.join(userData, 'config', 'examples.json');
        if ((await fs.stat(file)).size > 256 * 1024) throw Error('Local index is too large');
        local = parseExamples(JSON.parse(await fs.readFile(file, 'utf8'))).map(row => ({ ...row, collection: 'local' }));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('Your local example index needs attention; built-in examples are still available.'); }
      const seen = new Set(built.map(row => row.id));
      const examples = built.map(row => ({ ...row }));
      for (const row of local) {
        if (seen.has(row.id) || examples.length >= 128) { warnings.push('Some local entries have duplicate IDs or exceed the collection limit.'); continue; }
        seen.add(row.id); examples.push(row);
      }
      allowed.clear();
      for (const row of examples) {
        try { if (!(await fs.stat(row.file)).isFile()) throw Error('Missing project'); }
        catch { row.unavailable = 'Project file not found. Check the example folder.'; }
        if (row.preview) {
          try { const real = await fs.realpath(row.preview); if (!(await fs.stat(real)).isFile()) throw Error('Missing preview'); allowed.set(pathKey(row.preview), real); }
          catch { row.preview = undefined; }
        }
      }
      return { schemaVersion: 1, examples, ...(warnings.length ? { warning: [...new Set(warnings)].join(' ') } : {}) };
    },
    async allowsPreview(file: string): Promise<boolean> {
      const expected = allowed.get(pathKey(file));
      if (!expected) return false;
      try { return pathKey(await fs.realpath(file)) === pathKey(expected); } catch { return false; }
    },
  };
}
