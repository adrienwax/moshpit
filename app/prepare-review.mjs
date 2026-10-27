// Create separate, opt-in review launchers. Never starts either application or copies live preferences.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'app/package.json'), 'utf8')).version;
const ctRoot = path.resolve(process.env.WAXYCT_REVIEW_SOURCE ?? path.join(root, '../waxyct'));
const review = path.resolve(process.argv[2] ?? path.join(root, '../MORNING-TESTS-C1'));
const moshExe = path.join(root, 'out/releases', version, 'win-unpacked/Moshpit 3.exe');
const ctVersion = JSON.parse(fs.readFileSync(path.join(ctRoot, 'package.json'), 'utf8')).version;
const ctExe = path.join(ctRoot, 'release/final-commit', `waxyct.${ctVersion}`, 'waxyct.exe');
for (const file of [moshExe, ctExe]) if (!fs.existsSync(file)) throw new Error(`Build the candidate first: ${file}`);
if (fs.existsSync(review) && fs.readdirSync(review).length) throw new Error(`Review folder already contains files; preserve it and choose a new destination: ${review}`);

const moshProfile = path.join(review, 'profiles/moshpit');
const ctProfile = path.join(review, 'profiles/ct');
const ctConfig = path.join(ctProfile, 'config');
const write = (file, contents) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); };
const json = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
const cmd = (name, lines) => write(path.join(review, name), lines.join('\r\n') + '\r\n');
const output = path.join(review, 'output');
const projects = path.join(review, 'projects');
for (const folder of [output, projects, ctConfig]) fs.mkdirSync(folder, { recursive: true });
json(path.join(moshProfile, 'config/settings.json'), { paths: {
  media: '', output, cache: path.join(moshProfile, 'engine-cache'),
  recipes: path.join(review, 'looks'), projects, freeze: path.join(moshProfile, 'engine-cache/freeze'),
} });
// Only current repository defaults: no backup folders, user mapping history or installed settings.
for (const name of ['apps.json', 'settings.json', 'profiles', 'rigs']) fs.cpSync(path.join(ctRoot, 'config', name), path.join(ctConfig, name), { recursive: true });
const appsFile = path.join(ctConfig, 'apps.json');
const apps = JSON.parse(fs.readFileSync(appsFile, 'utf8'));
apps.moshpit.endpointFile = path.join(moshProfile, 'control-endpoint.json');
json(appsFile, apps);
json(path.join(ctProfile, 'router.json'), { port: 9991, hostAuto: false });

cmd('1 - Open Moshpit C1.cmd', [
  '@echo off', 'setlocal',
  'set "ELECTRON_RUN_AS_NODE="',
  'set "MOSHPIT_DEV_URL="',
  `set "MOSHPIT_USER_DATA=${moshProfile}"`,
  `set "MOSHPIT_ENGINE_CACHE=${path.join(moshProfile, 'engine-cache')}"`,
  'set "MOSHPIT_CACHE_IN_PROFILE=1"',
  `if not exist "${moshExe}" (echo Candidate is missing. & pause & exit /b 1)`,
  `start "Moshpit C1 review" /D "${path.dirname(moshExe)}" "${moshExe}"`,
]);
cmd('2 - Open CT C1.cmd', [
  '@echo off', 'setlocal',
  'set "ELECTRON_RUN_AS_NODE="',
  'powershell -NoProfile -Command "if ([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq 9991 }) { Write-Host \'Port 9991 is already in use. Close the previous review CT normally; do not start another router.\'; exit 1 }"',
  'if errorlevel 1 (pause & exit /b 1)',
  `set "WAXYCT_CONFIG=${ctConfig}"`,
  `set "WAXYCT_ROUTER_CONFIG=${path.join(ctProfile, 'router.json')}"`,
  `set "WAXYCT_BRIDGE=${path.join(path.dirname(ctExe), 'resources/ct')}"`,
  `if not exist "${ctExe}" (echo Candidate is missing. & pause & exit /b 1)`,
  `start "CT C1 review" /D "${path.dirname(ctExe)}" "${ctExe}" "--user-data-dir=${path.join(ctProfile, 'electron-user-data')}"`,
]);
console.log(`Prepared review launchers and fresh profiles at ${review}. Neither app was started.`);
