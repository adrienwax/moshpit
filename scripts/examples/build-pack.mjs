// Explicit build-time authoring, not application startup. ROOT runs this in the single native lane.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { writeSource } from './sources.mjs';
import { checkPack } from './check-pack.mjs';
import { ensureScratch, configureToolCaches, requireScratchOutput } from '../build-scratch/bootstrap.mjs';
const scratch = ensureScratch('portable-test');
configureToolCaches(scratch);

const root = path.resolve(import.meta.dirname, '../..');
const option = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const outArg = option('--out'), workArg = option('--work'), ffmpeg = process.env.MOSHPIT_FFMPEG;
if (!outArg || !workArg || !path.isAbsolute(outArg) || !path.isAbsolute(workArg) || !ffmpeg || !path.isAbsolute(ffmpeg)) throw Error('Supply absolute --out, --work and MOSHPIT_FFMPEG paths');
const out = requireScratchOutput(outArg), work = requireScratchOutput(workArg);
if (out === work || out.startsWith(work + path.sep) || work.startsWith(out + path.sep) || fs.existsSync(out) || fs.existsSync(work)) throw Error('Use two separate new output/work directories');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(work, { recursive: true });
for (const name of ['media', 'projects', 'previews']) fs.mkdirSync(path.join(out, name));
const electron = path.join(root, 'node_modules/electron/dist/electron.exe');
if (!fs.existsSync(electron) || !fs.existsSync(ffmpeg)) throw Error('Missing pinned local Electron/FFmpeg');
await build({ entryPoints: [path.join(import.meta.dirname, 'render-pack.ts')], outfile: path.join(work, 'renderer.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'chrome150', external: ['electron'], alias: { '@moshpit/core': path.join(root, 'core/src/index.ts'), '@moshpit/engine': path.join(root, 'engine/src/index.ts') }, logLevel: 'warning' });
fs.writeFileSync(path.join(work, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Moshpit example authoring</title><script>require("./renderer.cjs")</script>', { flag: 'wx' });
fs.writeFileSync(path.join(work, 'main.cjs'), `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path');
fs.mkdirSync(path.join(__dirname,'private-profile'),{recursive:true});
app.setPath('userData',path.join(__dirname,'private-profile'));
let win;
ipcMain.on('example-log',(_e,message)=>console.log(message));
ipcMain.on('example-done',(_e,result)=>{fs.writeFileSync(path.join(__dirname,'ENGINE-RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=result.status==='PASS'?0:1;app.quit();});
app.whenReady().then(()=>{win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});win.webContents.on('render-process-gone',(_e,details)=>{console.error(details);process.exitCode=1;app.quit();});win.loadFile(path.join(__dirname,'index.html'));});
`, { flag: 'wx' });
if (process.argv.includes('--prepare-only')) {
  console.log(JSON.stringify({ status: 'PREPARED_ONLY', out, work, notes: 'Compiled generator only; no media or native app launched. Use new directories for the full command.' }));
  process.exit(0);
}
for (const style of ['ribbons', 'orbit']) { console.log('Author original source: ' + style); await writeSource(ffmpeg, style, path.join(out, 'media', `${style}.mp4`)); }
const env = { ...process.env, MOSHPIT_EXAMPLE_OUT: out, MOSHPIT_EXAMPLE_WORK: work, MOSHPIT_CONTROL: '0' };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((resolve, reject) => {
  const child = spawn(electron, [path.join(work, 'main.cjs')], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Example renderer exited: ' + code)));
});
const evidence = JSON.parse(fs.readFileSync(path.join(work, 'ENGINE-RESULT.json')));
if (evidence.status !== 'PASS') throw Error('Engine example checks failed; work directory retained');
const examples = JSON.parse(fs.readFileSync(path.join(work, 'example-rows.json')));
examples.sort((a, b) => ['starter-p-frame-replay', 'starter-texture-carry', 'starter-chroma-ghost', 'starter-breathing-feedback'].indexOf(a.id) - ['starter-p-frame-replay', 'starter-texture-carry', 'starter-chroma-ghost', 'starter-breathing-feedback'].indexOf(b.id));
for (const row of examples) {
  execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', path.join(out, row.preview), '-f', 'null', '-'], { windowsHide: true, stdio: 'pipe' });
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE.txt'), fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(out, 'PROVENANCE.json'), JSON.stringify({ schemaVersion: 1, creator: 'ak wax', license: 'MIT', footage: 'Original deterministic procedural RGB footage generated by scripts/examples/sources.mjs; no external footage, fonts, logos or audio.', technique: 'Projects constructed with Moshpit constructors and previews rendered by its actual EngineService. Pixelord-inspired entries are mechanism studies, not reproductions of an external video.', generation: { width: 640, height: 360, fps: 30, frames: 240, sourceStyles: ['ribbons', 'orbit'] }, limits: 'Outputs can vary with codec/GPU versions. The manifest pins this generated pack; a newly generated pack receives a different content hash.' }, null, 2), { flag: 'wx' });
const files = fs.readdirSync(out, { recursive: true }).filter(n => fs.statSync(path.join(out, n)).isFile()).sort().map(n => ({ path: n.replaceAll(path.sep, '/'), sha256: createHash('sha256').update(fs.readFileSync(path.join(out, n))).digest('hex') }));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ schemaVersion: 1, packId: 'starter-studies-v1', examples, files }, null, 2), { flag: 'wx' });
const checked = checkPack(out);
fs.writeFileSync(path.join(work, 'PACK-RESULT.json'), JSON.stringify({ ...checked, fullPreviewDecode: true }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...checked, out, fullPreviewDecode: true }));
