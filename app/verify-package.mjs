// Verify the packaged candidate against this checkout's built files without launching the app.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
const output = path.resolve(process.argv[2] ?? path.join(root, 'out/releases', version));
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'BUILD-MANIFEST.json'), 'utf8'));
const build = JSON.parse(fs.readFileSync(path.join(here, 'dist/build-info.json'), 'utf8'));
assert.equal(build.version, version);
assert.equal(manifest.commit, build.commit);
assert.equal(manifest.dirty, false, 'Only a committed source candidate may be sealed');
const builder = path.resolve(process.env.MOSHPIT_BUILDER_CLI ?? path.join(root, 'node_modules/electron-builder/cli.js'));
const require = createRequire(builder);
const asar = await import(pathToFileURL(require.resolve('@electron/asar')).href);
const archive = path.join(output, 'win-unpacked/resources/app.asar');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const matched = [];
function verifyTree(directory, relative = 'dist') {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const source = path.join(directory, item.name), entry = `${relative}/${item.name}`;
    if (item.isDirectory()) verifyTree(source, entry);
    else {
      assert.equal(hash(asar.extractFile(archive, path.normalize(entry))), hash(fs.readFileSync(source)), `Packaged bytes differ: ${entry}`);
      matched.push(entry);
    }
  }
}
verifyTree(path.join(here, 'dist'));
const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
assert.equal(metadata.version, version);
assert.equal(metadata.main, 'dist/main.cjs');
const archived = asar.listPackage(archive);
assert(!archived.some(name => /(?:^|[\\/])(?:\.git|test-footage|settings\.json|control-endpoint\.json)(?:[\\/]|$)/.test(name)), 'Unexpected private/runtime data in archive');
for (const [name, expected] of Object.entries(manifest.mediaTools)) {
  const bytes = fs.readFileSync(path.join(output, 'win-unpacked/resources/ffmpeg', name));
  assert.equal(bytes.length, expected.bytes);
  assert.equal(hash(bytes), expected.sha256, `Packaged media tool differs: ${name}`);
}
const portable = fs.readFileSync(path.join(output, manifest.portable.file));
assert.equal(portable.length, manifest.portable.bytes);
assert.equal(hash(portable), manifest.portable.sha256);
const report = { version, commit: build.commit, verified: new Date().toISOString(), kind: 'Archive and tool byte comparison; no native application launched', matchedFiles: matched.length, files: matched, portable: manifest.portable };
fs.writeFileSync(path.join(output, 'PACKAGE-VERIFICATION.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Package verified: ${matched.length} archive files match; FFmpeg/ffprobe and portable hashes match; source ${build.commit}`);
