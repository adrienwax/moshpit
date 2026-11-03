import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const safe = value => typeof value === 'string' && value.length > 0 && value.length < 240 && !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..');
export function checkPack(directory) {
  const root = fs.realpathSync(directory);
  const manifestBytes = fs.readFileSync(path.join(root, 'manifest.json'));
  if (manifestBytes.length > 256 * 1024) throw Error('Example manifest too large');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || !/^[a-z0-9-]{1,80}$/.test(manifest.packId) || !Array.isArray(manifest.files) || manifest.files.length > 128 || !Array.isArray(manifest.examples) || manifest.examples.length !== 4) throw Error('Unexpected starter pack schema');
  const files = new Map(), ids = new Set(); let total = 0;
  for (const row of manifest.files) {
    if (!safe(row.path) || row.path === 'manifest.json' || files.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('Invalid/duplicate pack path or hash');
    const file = path.join(root, row.path), real = fs.realpathSync(file);
    if (!real.startsWith(root + path.sep) || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw Error('Redirected/non-file pack entry');
    const size = fs.statSync(file).size;
    if (size > 40 * 1024 * 1024 || total + size > 40 * 1024 * 1024) throw Error('Starter pack exceeds 40 MiB budget');
    const bytes = fs.readFileSync(file); total += bytes.length;
    if (hash(bytes) !== row.sha256) throw Error('Pack file hash mismatch: ' + row.path);
    files.set(row.path, bytes);
  }
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, entry), name = entry.replaceAll(path.sep, '/');
    if (fs.lstatSync(file).isSymbolicLink()) throw Error('Symbolic pack entry');
    if (fs.statSync(file).isFile() && name !== 'manifest.json' && !files.has(name)) throw Error('Unlisted pack file: ' + name);
  }
  for (const row of manifest.examples) {
    if (!row || typeof row.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(row.id) || ids.has(row.id) || !['pixelord', 'mix'].includes(row.group) || !files.has(row.file) || !row.file.endsWith('.mosh') || !files.has(row.preview) || !row.preview.endsWith('.mp4') || typeof row.title !== 'string' || typeof row.hint !== 'string' || !Number.isFinite(row.seconds) || row.seconds < 6 || row.seconds > 10) throw Error('Invalid example entry');
    ids.add(row.id);
  }
  function inspect(value) {
    if (typeof value === 'string') {
      if (value.startsWith('pack://')) { if (!files.has(value.slice(7))) throw Error('Unresolved pack reference'); }
      else if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || /CodexScratch|[\\/]Users[\\/]/i.test(value)) throw Error('Private/absolute project path');
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
  }
  inspect(manifest);
  for (const [name, bytes] of files) if (/\.(mosh|json)$/.test(name)) inspect(JSON.parse(bytes));
  return { status: 'PASS', packId: manifest.packId, files: files.size, examples: ids.size, bytes: total, manifestSHA256: hash(manifestBytes) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(checkPack(process.argv[2]), null, 2));
