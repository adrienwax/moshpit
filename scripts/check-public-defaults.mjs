import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {build,transform}=await import(process.env.MOSHPIT_ESBUILD_MODULE || 'esbuild');
const root=fileURLToPath(new URL('../',import.meta.url));
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'mp-public-defaults-'));
async function load(relative,name){
  const outfile=path.join(scratch,name+'.mjs');
  await build({entryPoints:[path.join(root,relative)],bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'});
  return import(pathToFileURL(outfile).href);
}
test('fresh engine cache stays in the profile, unless explicitly configured',async()=>{
  const {engineCacheRoot,engineCacheDir,previewDir}=await load('app/electron/engine-cache.ts','cache');
  const profile=path.join(scratch,'profile'),custom=path.join(scratch,'chosen-cache'),media=path.join(scratch,'media');
  assert.equal(engineCacheRoot(profile,undefined,{}),engineCacheDir(profile));
  assert.equal(engineCacheRoot(profile,'',{}),engineCacheDir(profile));
  assert.equal(engineCacheRoot(profile,custom,{}),path.join(custom,'engine'));
  assert.equal(engineCacheRoot(profile,media,{},[media]),engineCacheDir(profile));
  assert.equal(previewDir(profile,'',[media]),path.join(engineCacheDir(profile),'preview'));
  assert.equal(engineCacheRoot(profile,'',{MOSHPIT_ENGINE_CACHE:custom}),custom);
});
test('FFmpeg discovery uses explicit/env/PATH, with no studio fallback',async()=>{
  const {findFfmpeg}=await load('engine/src/conform/ffmpeg.ts','ffmpeg');
  const previous=process.env.MOSHPIT_FFMPEG;
  try{
    delete process.env.MOSHPIT_FFMPEG;
    assert.deepEqual(findFfmpeg(),{ffmpeg:'ffmpeg',ffprobe:'ffprobe'});
    const file=path.join(scratch,'ffmpeg.exe');fs.writeFileSync(file,'inert fixture');
    assert.equal(findFfmpeg(file).ffmpeg,file);
    process.env.MOSHPIT_FFMPEG=file;assert.equal(findFfmpeg().ffmpeg,file);
  }finally{if(previous===undefined)delete process.env.MOSHPIT_FFMPEG;else process.env.MOSHPIT_FFMPEG=previous;}
});
test('example footage is opt-in and fresh settings contain no personal directories',async()=>{
  const clips=await load('app/src/lib/testClips.ts','clips');
  assert.equal(clips.TEST_CLIPS_DIR,'');
  const text=fs.readFileSync(path.join(root,'app/src/state/ui.ts'),'utf8');
  const defaults=text.slice(text.indexOf('export const DEFAULT_SETTINGS'),text.indexOf('  defaults:',text.indexOf('export const DEFAULT_SETTINGS')));
  assert.match(defaults,/paths: \{ media: '', output: '', cache: '', recipes: '', projects: '', freeze: '' \}/);
});
test('render queue rejects unset output but preserves explicitly chosen destinations',async()=>{
  const text=fs.readFileSync(path.join(root,'app/src/state/render.ts'),'utf8');
  const method=text.slice(text.indexOf('export function queueRender('),text.indexOf('export async function runAll('));
  const {code}=await transform(method.replace('export function','function'),{loader:'ts'});
  const notices=[],jobs=[];
  const doc={name:'Demo',timeline:{blocks:[{}]},exportConfig:{outDir:'',format:'mp4-h264',width:1920,height:1080}};
  const settings={paths:{output:''}};
  const ctx=vm.createContext({getDoc:()=>doc,timelineFrames:()=>60,settingsStore:{get:()=>settings},toast:m=>notices.push(m),addJob:(...a)=>jobs.push(a)});
  vm.runInContext(code,ctx);
  ctx.queueRender();assert.equal(jobs.length,0);assert.match(notices[0],/Choose an output folder/);
  ctx.queueRender('Example','F:/Exports');assert.equal(jobs[0][2],'F:/Exports');
  settings.paths.output='G:/My exports';ctx.queueRender();assert.equal(jobs[1][2],'G:/My exports');
  doc.exportConfig.outDir='H:/Project exports';ctx.queueRender();assert.equal(jobs[2][2],'H:/Project exports');
});
