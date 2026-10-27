// Actual MarkHandles + actual project store/Immer/history. Only the normal browser mock engine is used.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(root,'output/playwright/range-history');await fs.mkdir(out,{recursive:true});
await build({stdin:{sourcefile:'range-history-fixture.tsx',resolveDir:root,loader:'tsx',contents:`
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MarkHandles} from './app/src/components/TimelineKit';
import {projectStore,getDoc,useProject,setMarks,commit,undo,redo,transact} from './app/src/state/project';
import {demoProject} from './app/src/engine/mockProject';
import {resetProjectJobs} from './app/src/state/jobs';
import {syncCalls} from './app/src/engine';
const source=demoProject().resources.sources[0];
function reset(){const doc=structuredClone(demoProject());doc.resources.sources[0].marks=[{id:'mark-fixture',in:10,out:30}];projectStore.set({doc,past:[],future:[]});transact(()=>setMarks(source.id,20,40));undo();}
reset();
function Fixture(){const marks=useProject(d=>d.resources.sources[0].marks[0]),lane=useRef(null);const [shown,setShown]=useState(true),[identity,setIdentity]=useState(source.id);
window.fixture={reset,getDoc,projectStore,undo,redo,commit,setShown,setIdentity,resetProjectJobs,syncCalls,setMarks:(i,o)=>setMarks(source.id,i,o)};
return <div ref={lane} className="scrub tall" style={{width:600}}>{shown&&<MarkHandles track={lane} identity={identity} marks={marks} view={{start:0,len:100}} total={100} isCurrent={()=>{const current=getDoc().resources.sources[0].marks[0];return current.in===marks.in&&current.out===marks.out}} setMarks={(i,o)=>setMarks(source.id,i,o)}/>}</div>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`},outfile:path.join(out,'fixture.js'),bundle:true,format:'iife',jsx:'automatic',alias:{'@moshpit/core':path.join(root,'core/src/index.ts'),'@moshpit/engine':path.join(root,'engine/src/index.ts')},plugins:[{name:'unused-icon-glob',setup(b){b.onLoad({filter:/components[\\/]Icon\.tsx$/},async({path:p})=>({contents:(await fs.readFile(p,'utf8')).replace(/import\.meta\.glob\([^\n]+?\)/,'{}'),loader:'tsx'}));}}],logLevel:'warning'});
const css=(await Promise.all(['app/src/styles/prototype.css','app/src/styles/tokens.css','shared/ui/tokens.css','app/src/components/timelineRange.css'].map(p=>fs.readFile(path.join(root,p),'utf8')))).join('\n');
await fs.writeFile(path.join(out,'index.html'),`<!doctype html><meta charset="utf-8"><style>${css}\nbody{display:block;padding:40px;overflow:auto}#root{height:200px}</style><div id="root"></div><script src="fixture.js"></script>`);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
const page=await browser.newPage({viewport:{width:900,height:500}}),errors=[];page.on('pageerror',e=>{errors.push(String(e));console.log('FIXTURE ERROR',String(e))});
await page.goto(pathToFileURL(path.join(out,'index.html')).href);const grip=page.getByRole('button',{name:'Move marked range'});await grip.waitFor({timeout:4000}).catch(async e=>{console.log('BODY',await page.locator('body').innerText());throw e});
const snapshot=()=>page.evaluate(()=>JSON.stringify(fixture.projectStore.get()));
const start=async(selector=grip)=>{const r=await selector.boundingBox();const x=r.x+r.width/2,y=r.y+Math.min(r.height/2,12);await page.mouse.move(x,y);await page.mouse.down();return{x,y};};
const reset=async()=>{await page.evaluate(()=>fixture.reset());await page.waitForFunction(()=>fixture.getDoc().resources.sources[0].marks[0].in===10);};
for(const reason of ['Escape','pointercancel','lostpointercapture','unmount']){
 await reset();const before=await snapshot(),syncBefore=await page.evaluate(()=>fixture.syncCalls.updateProject),p=await start();await page.mouse.move(p.x+60,p.y,{steps:3});
 assert.equal(await snapshot(),before,'project and history are unchanged during visual preview');
 assert.equal(await page.getByRole('slider',{name:'IN',exact:true}).getAttribute('aria-valuenow'),'20','overlay previews the staged range');
 if(reason==='Escape')await page.keyboard.press('Escape');else if(reason==='unmount')await page.evaluate(()=>fixture.setShown(false));else await page.locator('.scrub').dispatchEvent(reason,{pointerId:1});
 await page.mouse.up();assert.equal(await snapshot(),before,`${reason} preserves exact document, Undo and Redo`);
 assert.equal(await page.evaluate(()=>fixture.syncCalls.updateProject),syncBefore,'cancel does not send project updates to engine');
 await page.evaluate(()=>fixture.redo());assert.equal(await page.evaluate(()=>fixture.getDoc().resources.sources[0].marks[0].in),20,'prior Redo remains usable');
 if(reason==='unmount')await page.evaluate(()=>fixture.setShown(true));
}
await reset();const before=await snapshot();let p=await start();await page.mouse.move(p.x+60,p.y);await page.mouse.move(p.x,p.y);await page.mouse.up();assert.equal(await snapshot(),before,'returning to original range makes no history entry');
await reset();const syncBeforeCommit=await page.evaluate(()=>fixture.syncCalls.updateProject);p=await start();await page.mouse.move(p.x+60,p.y);await page.mouse.up();assert.equal(await page.evaluate(()=>fixture.syncCalls.updateProject),syncBeforeCommit+1,'release synchronizes committed marks once');assert.equal(await page.evaluate(()=>fixture.projectStore.get().past.length),1);assert.equal(await page.evaluate(()=>fixture.projectStore.get().future.length),0);await page.evaluate(()=>fixture.undo());assert.equal(await page.evaluate(()=>fixture.getDoc().resources.sources[0].marks[0].in),10);
await reset();p=await start();await page.mouse.move(p.x+60,p.y);await page.evaluate(()=>fixture.commit('Other edit',d=>{d.name='Keep this edit'}));const other=await snapshot();await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await snapshot(),other,'cancel preserves concurrent unrelated edit');
await reset();p=await start();await page.mouse.move(p.x+60,p.y);await page.evaluate(()=>fixture.setMarks(50,70));await page.mouse.up();assert.equal(await page.evaluate(()=>fixture.getDoc().resources.sources[0].marks[0].in),50,'concurrent source-mark edit supersedes stale preview');
await reset();p=await start();await page.mouse.move(p.x+60,p.y);await page.evaluate(({x,y})=>{fixture.setMarks(50,70);document.querySelector('.scrub').dispatchEvent(new PointerEvent('pointerup',{pointerId:1,clientX:x+60,clientY:y,bubbles:true}));},p);await page.mouse.up();assert.equal(await page.evaluate(()=>fixture.getDoc().resources.sources[0].marks[0].in),50,'same-turn CT edit supersedes stale preview before React rerenders');
await reset();const endpointBefore=await snapshot();p=await start(page.getByRole('slider',{name:'IN',exact:true}));await page.mouse.move(p.x+30,p.y);await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await snapshot(),endpointBefore,'endpoint cancellation also preserves history');
await reset();p=await start();await page.mouse.move(p.x+60,p.y);await page.evaluate(()=>{fixture.resetProjectJobs();fixture.reset()});const replaced=await snapshot();await page.mouse.up();assert.equal(await snapshot(),replaced,'same-id project replacement cancels staged edit');
await reset();p=await start();await page.mouse.move(p.x+60,p.y);const sourceBefore=await snapshot();await page.evaluate(()=>fixture.setIdentity('another-source'));await page.mouse.up();assert.equal(await snapshot(),sourceBefore,'source replacement cancels staged edit');
assert.deepEqual(errors,[]);const checks=['real project+Immer preview does not mutate history','Escape/cancel/unmount retain exact Undo+Redo','original Redo remains usable','no-op release preserves Redo','successful release is one undo','concurrent unrelated edit survives cancel','concurrent marks supersede stale preview','same-turn CT marks supersede stale preview','endpoint cancellation preserves history','same-id project replacement cancels old preview','source replacement cancels old preview','engine receives only a successful commit'];await fs.writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
}finally{await browser.close()}
