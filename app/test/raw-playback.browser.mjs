// Actual browser WebCodecs + Mediabunny + production PreviewSource. No native app or device.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'output/playwright/raw-playback');
await fs.mkdir(out, { recursive: true });
const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
  import { PreviewSource } from './engine/src/preview/source';
  import { createPlaybackPump } from './app/src/state/rawPlayback';
  window.run = async () => {
    const src = await PreviewSource.open('/fixture.mp4');
    const req = { playback:true, size:{w:160,h:160} }, times=[], hashes=[];
    const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
    const show=f=>{canvas.width=f.w;canvas.height=f.h;ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data),f.w,f.h),0,0);};
    const begin=performance.now();
    for(let n=0;n<60;n++) {
      const f=await src.frame((n+.5)/30,req); if(!f) throw Error('missing sequential frame '+n);
      times.push(f.time); let hash=2166136261; for(let i=0;i<f.data.length;i+=13) hash=Math.imul(hash^f.data[i],16777619); hashes.push(hash>>>0); show(f);
    }
    const decodeMs=performance.now()-begin;
    const loop=await src.frame(.5/30,req);
    const paused=await src.frame(7.5/30,{exact:true,size:req.size});
    const draws=[],errors=[];
    const pump=createPlaybackPump(async time=>{
      const f=await src.frame(time,req); if(!f)return null;
      return {...f,image:await createImageBitmap(new ImageData(new Uint8ClampedArray(f.data),f.w,f.h))};
    },f=>{draws.push(f.time);canvas.width=f.w;canvas.height=f.h;ctx.drawImage(f.image,0,0);},e=>errors.push(String(e)));
    // Feed a 30 fps media clock, as SliceTrack does, independent of decode completion.
    for(let n=0;n<30;n++){pump.request((n+.5)/30);await new Promise(r=>setTimeout(r,1000/30));}
    await new Promise(r=>setTimeout(r,150));pump.stop();src.close();
    return {times,distinctPixels:new Set(hashes).size,decodeMs,loop:loop?.time,paused:paused?.time,draws,errors};
  };
` }, bundle: true, write: false, format: 'iife', plugins: [{ name: 'browser-fixture-input', setup(b) {
  b.onLoad({ filter: /[\\/]preview[\\/]probe\.ts$/ }, () => ({ loader: 'ts', resolveDir: root, contents: `import {Input,BufferSource,ALL_FORMATS} from 'mediabunny'; export async function openInput(path){return new Input({source:new BufferSource(await (await fetch(path)).arrayBuffer()),formats:ALL_FORMATS})}` }));
}}], logLevel:'warning' });
const movie = await fs.readFile(path.join(root,'fixtures/pv-rot90.mp4'));
const server=createServer((req,res)=>{
  if(req.url==='/fixture.mp4'){res.writeHead(200,{'Content-Type':'video/mp4'});res.end(movie);}
  else if(req.url==='/fixture.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(built.outputFiles[0].contents);}
  else {res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><h1>Raw sequential playback</h1><canvas></canvas><script src="/fixture.js"></script>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(()=>window.run());
  assert.equal(result.times.length,60);
  for(let i=0;i<60;i++)assert.ok(Math.abs(result.times[i]-i/30)<.001,`frame ${i} drew ${result.times[i]}`);
  assert.ok(result.distinctPixels>45,`only ${result.distinctPixels} distinct frames`);
  assert.ok(Math.abs(result.loop)<.001);assert.ok(Math.abs(result.paused-7/30)<.001);
  assert.ok(result.draws.length>=24,`only ${result.draws.length}/30 clock frames displayed`);
  assert.ok(result.draws.every((t,i)=>i===0||t>result.draws[i-1]),'playback must progress monotonically');
  assert.deepEqual(result.errors,[]);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(out,'decoded-frame.png')});
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify({kind:'Headless Edge, actual browser WebCodecs; isolated source adapter only; no native application',...result},null,2));
  console.log(`raw browser playback: 60 exact advancing frames, ${result.distinctPixels} pixel-distinct; ${result.draws.length}/30 clock frames; loop and paused exact step passed (${Math.round(result.decodeMs)}ms decode)`);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
