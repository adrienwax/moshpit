// Renderer-only review: real Browse component/CSS, mocked host and thumbnails.
// No Electron, engine, hardware, media decoding or owner configuration is used.
import { ensureScratch, configureToolCaches } from '../../scripts/build-scratch/bootstrap.mjs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const scratch=ensureScratch('build');configureToolCaches(scratch);
const root=path.resolve(import.meta.dirname,'../..');
if(!process.env.EXAMPLE_BROWSER_MANIFEST)throw Error('Set EXAMPLE_BROWSER_MANIFEST to the reviewed starter pack manifest');
const manifest=JSON.parse(await fs.readFile(process.env.EXAMPLE_BROWSER_MANIFEST,'utf8'));
const bundled=manifest.examples.map(row=>({...row,collection:'bundled',file:'C:/Example fixture/'+row.file,preview:'C:/Example fixture/'+row.preview}));
assert.equal(bundled.length,4);
const rows=[...bundled,...Array.from({length:12},(_,i)=>({...bundled[i%4],id:'local-'+i,title:bundled[i%4].title+' · local '+(i+1),collection:'local'}))];
const out=path.join(scratch.artifacts,'browse-renderer');await fs.mkdir(out);
const stubs={
  'host.ts':'export const host={};',
  'state/lifecycle.ts':'export const desktop=()=>false;export const openExample=async()=>{};export const useLife=()=>false;',
  'state/project.ts':'export const projectStore={};',
  'state/ui.ts':'export const setWs=()=>{};',
  'state/previews.ts':'export const previewMediaUrl=()=>undefined;',
  'components/RawPreview.tsx':'import React from "react";export function CellThumb(){return <svg viewBox="0 0 64 36" aria-hidden="true"><path fill="#183338" d="M0 0h64v36H0z"/><path fill="#52cddd" d="M8 6h8v24H8zm16 6h8v18h-8zm16-4h8v22h-8z"/></svg>}',
};
const source=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ExampleBrowser} from './app/src/ws/home/ExamplesPane';
import '@fontsource-variable/inter';import '@fontsource-variable/jetbrains-mono';
import './app/src/styles/prototype.css';import './app/src/styles/app.css';import './app/src/styles/tokens.css';import './shared/ui/tokens.css';import './app/src/styles/design.css';
const initial=${JSON.stringify(rows)};window.opened=[];
function Fixture(){const[rows,setRows]=useState(initial);const[warning,setWarning]=useState('');const[busy,setBusy]=useState(false);window.fixture={setRows,setWarning,setBusy,initial};return <div className="fixture-shell"><header>Moshpit · Home · Browser-only review fixture</header><aside>Start / Folders</aside><main className="home-project-hub"><section className="home-examples"><ExampleBrowser rows={rows} warning={warning} busy={busy} canOpen onOpen={r=>window.opened.push(r.id)}/></section><h3 className="home-project-heading">Recent projects</h3></main><aside>System / Session</aside></div>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
await build({stdin:{contents:source,loader:'tsx',resolveDir:root,sourcefile:'example-fixture.tsx'},bundle:true,outfile:path.join(out,'fixture.js'),platform:'browser',format:'iife',jsx:'automatic',loader:{'.woff2':'file'},plugins:[{name:'isolate-host',setup(b){b.onLoad({filter:/[\\/]app[\\/]src[\\/]/},args=>{const rel=args.path.replaceAll('\\','/').split('/app/src/')[1];return stubs[rel]?{contents:stubs[rel],loader:rel.endsWith('tsx')?'tsx':'ts',resolveDir:path.dirname(args.path)}:undefined;});}}],logLevel:'warning'});
const wrapper=`html,body{height:100%;overflow:hidden}.fixture-shell{height:100vh;display:grid;grid-template-columns:260px minmax(0,1fr) 300px;grid-template-rows:60px minmax(0,1fr);gap:4px}.fixture-shell>header{grid-column:1/-1;padding:16px;border-bottom:1px solid var(--line)}.fixture-shell>aside{padding:12px;border:1px solid var(--line);color:var(--txt-2)}.fixture-shell>main{border:1px solid var(--line)}@media(max-width:1000px){.fixture-shell{grid-template-columns:minmax(0,1fr)}.fixture-shell>aside{display:none}}`;
const html='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>'+wrapper+'</style><div id="root"></div><script src="/fixture.js"></script>';
const assets=new Set(await fs.readdir(out));
const server=createServer(async(req,res)=>{const name=(req.url||'').slice(1);if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);return;}if(!assets.has(name)){res.writeHead(404).end();return;}res.setHeader('content-type',name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'text/javascript');res.end(await fs.readFile(path.join(out,name)));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;const errors=[],checks=[],geometry=[];
try{
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-gpu']});
 const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(10000);
 await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('heading',{name:'Browse projects'}).waitFor();
 const list=page.getByRole('group',{name:'Projects',exact:true}), search=page.getByRole('searchbox',{name:'Search example projects'});
 assert.equal(await list.locator('button').count(),16);
 await search.fill('chroma');assert.equal(await list.locator('button').count(),4);await search.fill('not-a-technique');assert.equal(await list.locator('button').count(),0);await page.getByRole('button',{name:'Clear filters'}).click();
 await page.getByRole('button',{name:'Recipe mixes',exact:true}).click();assert.equal(await list.locator('button').count(),8);await page.getByRole('button',{name:'All',exact:true}).click();checks.push('Search, category and clear-filters preserve usable browsing');
 await list.locator('button').first().focus();await page.keyboard.press('ArrowDown');assert.equal(await list.locator('button[aria-pressed=true]').count(),1);assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-pressed')),'true');assert.equal(await page.locator('.example-detail h4').innerText(),bundled[1].title);
 await page.keyboard.press('End');assert.match(await page.locator('.example-detail h4').innerText(),/local 12/);await page.keyboard.press('Home');assert.equal(await page.locator('.example-detail h4').innerText(),bundled[0].title);checks.push('Arrow/Home/End selection keeps focus and selected detail aligned');
 await page.getByRole('button',{name:'Open a copy',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.opened),[bundled[0].id]);await page.evaluate(()=>window.fixture.setBusy(true));await page.waitForFunction(()=>document.querySelector('.example-open-bar button').disabled);assert.equal(await page.getByRole('button',{name:'Open a copy',exact:true}).isDisabled(),true);await page.evaluate(()=>window.fixture.setBusy(false));await page.waitForFunction(()=>!document.querySelector('.example-open-bar button').disabled);checks.push('Open uses selected ID; busy state prevents a second open');
 for(const [width,height]of [[1440,900],[1280,800],[620,800],[360,740]]){
  await page.setViewportSize({width,height});await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>new Promise(requestAnimationFrame));
  const measure=await page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {viewport:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,monitor:rect('.example-monitor'),video:rect('.example-monitor video'),open:rect('.example-open-bar button'),desk:rect('.example-desk'),list:rect('.example-list')};});
  assert(measure.overflow<=1,JSON.stringify(measure));assert(Math.abs(measure.video.width-(measure.monitor.width-2))<=2,JSON.stringify(measure));assert(measure.open.right<=width&&measure.open.bottom<=height,JSON.stringify(measure));if(width>=1280)assert(measure.monitor.height>=200,JSON.stringify(measure));
  geometry.push({width,height,...measure});await page.screenshot({path:path.join(out,`browse-${width}.png`)});
 }checks.push('Full home-column widths and narrow panels fit without horizontal overflow; open button remains visible');
 await page.setViewportSize({width:1280,height:800});await page.locator('.example-monitor video').dispatchEvent('error');await page.waitForFunction(()=>!document.querySelector('.example-monitor video'));assert.equal(await page.getByRole('button',{name:'Open a copy',exact:true}).isEnabled(),true);assert.match(await page.locator('.example-monitor').innerText(),/Preview unavailable/);checks.push('Preview error does not prevent opening a valid project');
 await page.evaluate(()=>window.fixture.setRows([{...window.fixture.initial[1],unavailable:'Project file not found. Check the example folder.'}]));await page.waitForFunction(()=>document.querySelector('.example-open-bar button').disabled);assert.equal(await page.getByRole('button',{name:'Open a copy',exact:true}).isDisabled(),true);assert.match(await page.locator('.example-detail').innerText(),/Project file not found/);
 await page.evaluate(()=>window.fixture.setRows([]));await page.locator('.example-empty').waitFor();assert.match(await page.locator('.example-empty').innerText(),/No examples/);checks.push('Missing project and empty collection retain clear explanations');assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({status:'PASS',checks,geometry,errors,limits:['Renderer-only fixture; thumbnails and host mocked; no video decode, native app, hardware or save test.']},null,2));console.log(JSON.stringify({status:'PASS',checks,geometry,out}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
