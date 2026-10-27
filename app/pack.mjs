// Package this checkout as a separate Windows testing candidate. No app is launched.
// Outputs and child temp are isolated on E. MOSHPIT_PACK_OUT can choose another
// fresh E-drive output. Cleanup belongs to the full-process-tree scratch wrapper.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureScratch, configureToolCaches, requireScratchOutput } from '../scripts/build-scratch/bootstrap.mjs';

const managed = ensureScratch('package');
const unpackedOnly = process.argv.includes('--unpacked');
configureToolCaches(managed);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const appPkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const ffmpegDir = process.env.MOSHPIT_FFMPEG_DIR;
if (!ffmpegDir || !path.isAbsolute(ffmpegDir)) throw new Error('Set MOSHPIT_FFMPEG_DIR to the absolute folder containing the reviewed FFmpeg and FFprobe binaries.');
const output = requireScratchOutput(process.env.MOSHPIT_PACK_OUT ?? path.join(managed.artifacts, 'releases', appPkg.version));
const buildOut = path.join(managed.artifacts, 'app-dist');
if (process.env.MOSHPIT_SCRATCH) throw new Error('MOSHPIT_SCRATCH is retired: this run owns a unique E-drive temp directory.');
if (process.argv.includes('--plan')) {
  const plan = { planOnly: true, run: managed.run, temp: managed.temp, artifacts: managed.artifacts, output, buildOut, electronCache: process.env.electron_config_cache, builderCache: process.env.ELECTRON_BUILDER_CACHE };
  fs.writeFileSync(path.join(managed.artifacts, 'PACKAGE-PLAN.json'), JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify(plan));
  process.exit(0);
}
const builder = path.resolve(process.env.MOSHPIT_BUILDER_CLI ?? path.join(root, 'node_modules', 'electron-builder', 'cli.js'));
const electronDir = path.join(root, 'node_modules', 'electron');
const electronVersion = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version;
const declaredElectron = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.electron;
if (electronVersion !== declaredElectron) throw new Error(`pack: Electron ${electronVersion} differs from the declared ${declaredElectron}; install the locked runtime first`);
if (!fs.existsSync(builder)) throw new Error('pack: install electron-builder 26.15.3 locally, or set MOSHPIT_BUILDER_CLI to that pinned version\'s cli.js. No tooling is downloaded implicitly.');
const builderVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(builder), 'package.json'), 'utf8')).version;
if (builderVersion !== '26.15.3') throw new Error(`pack: electron-builder ${builderVersion}; expected pinned 26.15.3`);
for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) if (!fs.existsSync(path.join(ffmpegDir, exe))) throw new Error(`pack: ${exe} not found in ${ffmpegDir}; set MOSHPIT_FFMPEG_DIR`);
if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error(`pack: output is not empty: ${output}. Use a fresh MOSHPIT_PACK_OUT; previous builds are preserved.`);
const tmp = managed.temp;
const env = { ...process.env, MOSHPIT_BUILD_OUT: buildOut };
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mediaTools = Object.fromEntries(['ffmpeg.exe', 'ffprobe.exe'].map(name => [name, { bytes: fs.statSync(path.join(ffmpegDir, name)).size, sha256: sha256(path.join(ffmpegDir, name)) }]));

execFileSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit', cwd: root, env, windowsHide: true });
const stage = fs.mkdtempSync(path.join(tmp, 'moshpit-stage-'));
{
  fs.cpSync(buildOut, path.join(stage, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: 'moshpit', productName: 'Moshpit 3', version: appPkg.version, description: `Moshpit ${appPkg.version} datamosh editor`,
    author: 'ak wax', main: 'dist/main.cjs',
  }, null, 2));
  const config = {
    appId: 'com.waxy.moshpit3', productName: 'Moshpit 3', electronVersion,
    electronDist: path.join(electronDir, 'dist'),
    directories: { app: stage, output }, files: ['dist/**', 'package.json'], asar: true, npmRebuild: false,
    extraResources: [{ from: ffmpegDir, to: 'ffmpeg', filter: ['ffmpeg.exe', 'ffprobe.exe'] }],
    win: { target: [{ target: 'portable', arch: ['x64'] }], icon: path.join(here, 'build', 'icon.png'), signAndEditExecutable: true },
    portable: { artifactName: 'Moshpit-${version}-portable.${ext}' },
  };
  const configFile = path.join(stage, 'electron-builder.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  // Direct Node invocation preserves Windows paths with spaces and needs no shell/npx.
  execFileSync(process.execPath, [builder, '--win', ...(unpackedOnly ? ['--dir'] : []), '--projectDir', stage, '--config', configFile], { stdio: 'inherit', cwd: root, env, windowsHide: true });
  fs.copyFileSync(path.join(root, 'QUICKSTART.md'), path.join(output, 'QUICKSTART.md'));
  const exe = unpackedOnly ? path.join(output, 'win-unpacked', 'Moshpit 3.exe') : path.join(output, `Moshpit-${appPkg.version}-portable.exe`);
  const build = JSON.parse(fs.readFileSync(path.join(buildOut, 'build-info.json'), 'utf8'));
  fs.writeFileSync(path.join(output, 'BUILD-MANIFEST.json'), JSON.stringify({ ...build, electron: electronVersion, builder: builderVersion, mediaTools, packageKind: unpackedOnly ? 'unpacked-runtime' : 'portable', [unpackedOnly ? 'executable' : 'portable']: { file: path.basename(exe), bytes: fs.statSync(exe).size, sha256: sha256(exe) } }, null, 2) + '\n');
  console.log(`pack: ${output}`);
}
