// Browser-only actual viewer/control integration, using the existing mock engine.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { ensureScratch, configureToolCaches } from '../../scripts/build-scratch/bootstrap.mjs';
const scratch=ensureScratch('build');configureToolCaches(scratch);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(scratch.artifacts,'usability-workflows');await fs.mkdir(out);
await build({stdin:{sourcefile:'unified-viewer.tsx',resolveDir:root,loader:'tsx',contents:`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {engine} from './app/src/engine';
import {previewsStore} from './app/src/state/previews';
import {resetProjectJobs} from './app/src/state/jobs';
import {host} from './app/src/host';
import {App} from './app/src/shell/App';
import {lifeStore} from './app/src/state/lifecycle';
import {uiStore,setUi} from './app/src/state/ui';
import {projectStore,useProject,selectBlock,selectNode,appendEffect,stepHistory} from './app/src/state/project';
import {slotPlayback} from './app/src/state/slotPlayback';
import {usePlayback} from './app/src/components/SliceTrack';
import {layoutStore,DEFAULT_LAYOUTS} from './app/src/layout/model';
import {instance} from './app/src/engine/mockProject';
import {timelineFrames,blockStarts} from './app/src/lib/timeline';
import './app/src/styles/prototype.css';import './app/src/styles/app.css';import './app/src/styles/tokens.css';
import '@xyflow/react/dist/style.css';import '@fontsource-variable/inter';import '@fontsource-variable/jetbrains-mono';import './shared/ui/tokens.css';import './app/src/styles/design.css';import './app/src/styles/focused-workspaces.css';
const original=projectStore.get().doc; const block=original.timeline.blocks[1]; const effect=block.graph.nodes.find(n=>n.kind.startsWith('fx.')); projectStore.set(s=>({...s,doc:{...s.doc,view:{...s.doc.view,perBlock:{...s.doc.view.perBlock,[block.id]:{pan:{x:0,y:0},zoom:1,selected:[effect.id]}}}}})); const doc=projectStore.get().doc;
setUi({ws:'mosh',playhead:30,playing:false,loupes:{A:{src:doc.resources.sources[0].id,frame:10},B:{src:doc.resources.sources[1].id,frame:20}}});
engine.updateProject(projectStore.get().doc);
projectStore.subscribe(()=>engine.updateProject(projectStore.get().doc));
let heldDoc;
let folderResult='/chosen/exports', finishPicker;
host.files={pickFolder:async()=>{if(folderResult==='WAIT')return new Promise(resolve=>{finishPicker=resolve;});if(folderResult==='ERROR')throw new Error('Picker unavailable');return folderResult;}};
window.fixture={finishPicker:(v)=>finishPicker(v),resetSession:resetProjectJobs,seedPreview:()=>previewsStore.set([{id:'sample',path:'/preview_sample.mp4',label:'Sample',projectId:projectStore.get().doc.id,scope:'Block 2',createdAt:Date.now()}]),folderResult:(value)=>{folderResult=value;},setFile:(file)=>lifeStore.set(s=>({...s,file})),ui:()=>uiStore.get(),playback:()=>slotPlayback.get(),doc:()=>projectStore.get().doc,select:(i)=>selectBlock(projectStore.get().doc.timeline.blocks[i].id),
selectEffect:(i)=>{const b=projectStore.get().doc.timeline.blocks[i];selectNode(b.id,b.graph.nodes.find(n=>n.kind.startsWith('fx.')).id)},
setUi,undo:()=>stepHistory(true),redo:()=>stepHistory(false),
transform:()=>{const b=projectStore.get().doc.timeline.blocks[3];appendEffect(b.id,'fx.transform');selectNode(b.id,projectStore.get().doc.timeline.blocks[3].graph.nodes.find(n=>n.kind==='fx.transform').id);},
six:()=>{projectStore.set(s=>{const blocks=[60,180,12,96,120,60].map((frames,i)=>({...structuredClone(s.doc.timeline.blocks[i%2]),id:'six-'+i,in:0,out:frames,repeat:1,kind:i===0||i===2||i===5?'picture':'motion'}));const perBlock=Object.fromEntries(blocks.map(b=>[b.id,{pan:{x:0,y:0},zoom:1,selected:b.graph.nodes.filter(n=>n.kind.startsWith('fx.')).slice(0,1).map(n=>n.id)}]));return {...s,doc:{...s.doc,settings:{...s.doc.settings,fps:{num:60,den:1}},timeline:{...s.doc.timeline,blocks},view:{...s.doc.view,activeBlock:blocks[3].id,perBlock}}}});},
one:()=>projectStore.set(s=>({...s,doc:{...s.doc,timeline:{...s.doc.timeline,blocks:s.doc.timeline.blocks.slice(0,1)},view:{...s.doc.view,activeBlock:s.doc.timeline.blocks[0].id}}})),
legacy:()=>layoutStore.set(s=>({...s,current:{mosh:[{id:'dock',w:280,stacks:[{id:'c',panes:['clips','library','slots'],active:1,f:1}]},{id:'main',stacks:[{id:'p',panes:['program'],active:0,f:3},{id:'e',panes:['edit'],active:0,f:2}]},{id:'inspect',w:350,stacks:[{id:'i',panes:['effects','block','graph','render'],active:0,f:1}]}]}})),
emptyEdit:()=>{heldDoc=projectStore.get().doc;projectStore.set(s=>({...s,doc:{...s.doc,timeline:{...s.doc.timeline,blocks:[]},view:{...s.doc.view,activeBlock:undefined}}}));},
restore:()=>projectStore.set(s=>({...s,doc:heldDoc})),
emptyProject:()=>projectStore.set(s=>({...s,doc:{...s.doc,timeline:{...s.doc.timeline,blocks:[]},resources:{...s.doc.resources,sources:[],conforms:[]},view:{...s.doc.view,activeBlock:undefined}}})),
layouts:()=>layoutStore.get(),start:(i)=>blockStarts(projectStore.get().doc.timeline.blocks)[i],
empty:()=>projectStore.set(s=>({...s,doc:{...s.doc,resources:{sources:[],conforms:[]}}}))};
function Fixture(){return <App/>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`},outfile:path.join(out,'fixture.js'),bundle:true,format:'iife',jsx:'automatic',alias:{'@moshpit/core':path.join(root,'core/src/index.ts'),'@moshpit/engine':path.join(root,'engine/src/index.ts')},loader:{'.woff2':'file'},plugins:[{name:'house-icons',setup(b){b.onLoad({filter:/[\\/]components[\\/]Icon\.tsx$/},async args=>{const icons=Object.fromEntries(await Promise.all((await fs.readdir(path.join(root,'app/src/icons'))).filter(f=>f.endsWith('.svg')).map(async f=>['../icons/'+f,await fs.readFile(path.join(root,'app/src/icons',f),'utf8')])));const source=await fs.readFile(args.path,'utf8');return {contents:source.replace(/import\.meta\.glob\([^\n]+?\) as Record<string, string>/,JSON.stringify(icons)),loader:'tsx',resolveDir:path.dirname(args.path)};});}}],logLevel:'warning'});
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');

const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
// Test-only in-memory origin serves this bundled source fixture; no application server or owner session.
await page.route('https://inspector.test/**',async route=>{
  const name=new URL(route.request().url()).pathname.slice(1)||'index.html';
  if(!/^[\w.-]+$/.test(name))return route.abort();
  const type=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':'text/html';
  await route.fulfill({body:await fs.readFile(path.join(out,name)),contentType:type});
});

const errors=[];page.on('pageerror',e=>errors.push(String(e)));
try {
  await page.goto('https://inspector.test/');
  await page.locator('.program-monitors').waitFor();
  const clip = await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d'); const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];
    recorder.ondataavailable=e=>chunks.push(e.data);
    const done=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
    for(let i=0;i<12;i++){ctx.fillStyle='#17232d';ctx.fillRect(0,0,640,360);ctx.fillStyle='#4bd2dd';ctx.fillRect(i*40,60,120,240);ctx.fillStyle='#f4cf82';ctx.font='26px sans-serif';ctx.fillText('CAPTURE PLAYBACK · TEST FIXTURE',30,38);await new Promise(r=>setTimeout(r,100));}
    recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());
    const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);
  });
  await page.route('moshpit://app/media/**',route=>route.fulfill({body:Buffer.from(clip,'base64'),contentType:'video/webm'}));
  await page.evaluate(()=>window.fixture.seedPreview());
  for(const size of [{width:1440,height:900},{width:1280,height:800}]) {
    await page.setViewportSize(size);
    assert.equal(await page.locator('[data-col=dock] .ptabs').count(),0);
    assert.ok(await page.locator('[data-loupe=A]').isVisible());
    assert.ok(await page.locator('[data-loupe=B]').isVisible());
    await page.screenshot({path:path.join(out,'edit-'+size.width+'.png')});
    await page.getByRole('group',{name:'Monitor content'}).getByRole('button',{name:'Captures',exact:true}).click();
    const media=await page.locator('.capture-monitor .preview-shelf-media').boundingBox();
    assert.ok(media.height>=180, 'captured picture needs at least 180px height: '+JSON.stringify(media));
    assert.ok(media.y>=0&&media.y+media.height<size.height,'capture visible without scrolling');
    assert.equal(await page.locator('.capture-monitor').evaluate(el=>el.scrollHeight>el.clientHeight+2),false,'no scroll inside capture monitor');
    assert.equal(await page.locator('.capture-monitor').evaluate(el=>el.scrollWidth>el.clientWidth+2),false,'no sideways capture scrolling');
    assert.ok(await page.locator('[data-col=inspect] .inspector-chain').isVisible());
    const video=page.locator('.capture-monitor video');
    await video.evaluate(v=>v.play());await page.waitForFunction(()=>document.querySelector('.capture-monitor video')?.currentTime>0);
    await page.getByRole('button',{name:'Replay',exact:true}).focus();await page.keyboard.press('Space');
    assert.ok(await video.evaluate(v=>v.paused));assert.equal((await page.evaluate(()=>window.fixture.ui())).playing,false);
    await page.keyboard.press('Space');assert.equal(await video.evaluate(v=>v.paused),false);
    await page.getByRole('button',{name:'Expand',exact:true}).click();await page.getByRole('dialog',{name:'Preview selection'}).waitFor();
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'Preview selection'}).count(),0);
    await page.screenshot({path:path.join(out,'capture-'+size.width+'.png')});
    await page.getByRole('group',{name:'Monitor content'}).getByRole('button',{name:'Edit',exact:true}).click();
  }
  // Clicking Step leaves its button focused. Space must play, not step again.
  await page.locator('.program .preview-buttons').getByRole('button',{name:'Next frame',exact:true}).click();
  const frame=(await page.evaluate(()=>window.fixture.ui())).playhead;
  await page.keyboard.press('Space');
  assert.equal((await page.evaluate(()=>window.fixture.ui())).playing,true);
  await page.keyboard.press('Space');
  assert.equal((await page.evaluate(()=>window.fixture.ui())).playing,false);
  assert.ok((await page.evaluate(()=>window.fixture.ui())).playhead>=frame);
  const file=page.locator('.command-menu>summary').filter({hasText:/^File$/});
  await file.focus();await page.keyboard.press('Space');
  assert.equal((await page.evaluate(()=>window.fixture.ui())).playing,false);
  assert.ok(await page.getByRole('button',{name:'New project',exact:false}).isVisible());
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.fixture.setUi({ws:'render'}));
  const folder=page.getByRole('textbox',{name:'Output folder',exact:true});
  await folder.waitFor();
  await page.getByRole('button',{name:'Browse…',exact:true}).click();
  assert.equal(await folder.inputValue(),'/chosen/exports');
  assert.equal(await page.evaluate(()=>window.fixture.doc().exportConfig.outDir),'/chosen/exports');
  await page.evaluate(()=>window.fixture.folderResult(null));
  await page.getByRole('button',{name:'Browse…',exact:true}).click();
  assert.equal(await folder.inputValue(),'/chosen/exports','cancel preserves directory');
  await folder.focus();await page.keyboard.press('End');await page.keyboard.type(' two');
  assert.equal((await page.evaluate(()=>window.fixture.ui())).playing,false,'typing a space never plays');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>window.fixture.doc().exportConfig.outDir),'/chosen/exports two');
  await page.evaluate(()=>window.fixture.folderResult('ERROR'));
  await page.getByRole('button',{name:'Browse…',exact:true}).click();
  assert.equal(await folder.inputValue(),'/chosen/exports two');
  assert.ok(await page.getByRole('button',{name:'Browse…',exact:true}).isEnabled());
  await page.evaluate(()=>window.fixture.folderResult('WAIT'));
  await page.getByRole('button',{name:'Browse…',exact:true}).click();
  await page.getByRole('button',{name:'Choosing…',exact:true}).waitFor();
  await page.evaluate(()=>{window.fixture.resetSession();window.fixture.finishPicker('/stale/choice');});
  await page.getByRole('button',{name:'Browse…',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixture.doc().exportConfig.outDir),'/chosen/exports two','folder result cannot cross project sessions');
  await page.screenshot({path:path.join(out,'export.png')});
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({status:'PASS',scope:'Actual React UI with mock engine and folder picker; not native media/installer evidence'},null,2));
  console.log(JSON.stringify({out,status:'PASS'}));
}catch(error){await page.screenshot({path:path.join(out,'FAIL.png')}).catch(()=>{});console.log(JSON.stringify({out,errors}));throw error;}
finally{await browser.close()}
