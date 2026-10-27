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
const out=path.join(scratch.artifacts,'inspector-desk');await fs.mkdir(out);
await build({stdin:{sourcefile:'unified-viewer.tsx',resolveDir:root,loader:'tsx',contents:`
import React from 'react'; import {createRoot} from 'react-dom/client';
import {engine} from './app/src/engine';
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
window.fixture={setFile:(file)=>lifeStore.set(s=>({...s,file})),ui:()=>uiStore.get(),playback:()=>slotPlayback.get(),doc:()=>projectStore.get().doc,select:(i)=>selectBlock(projectStore.get().doc.timeline.blocks[i].id),
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
const checks=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));
const ui=()=>page.evaluate(()=>window.fixture.ui());
const transport=page.locator('.preview-transport');
const shot=async name=>page.screenshot({path:path.join(out,name+'.png')});
try{
  await page.goto('https://inspector.test/');await transport.waitFor();
  await page.evaluate(()=>window.fixture.setFile('X:/Examples/Example edit.mosh'));
  assert.match(await page.getByLabel('Current project').innerText(),/Example edit.mosh/);
  assert.equal(await page.getByRole('navigation',{name:'MOSH tools',exact:true}).count(),1);
  assert.ok(await page.locator('.workspace-row .desk-tools').isVisible());
  assert.equal(await page.locator('[data-col=inspect] .card').count(),1);
  assert.ok(await page.locator('.inspector-chain').isVisible());
  checks.push('Filename visible; single topbar context strip; resident inspector with chain');
  const info=page.getByRole('region',{name:'Info',exact:true});
  const helpText=page.locator('#moshpit-tip');
  const chainEffect=page.locator('.applied-nodes button').first();
  const chainHelp=await chainEffect.getAttribute('title');
  assert.ok(chainHelp.length>20);
  await chainEffect.hover();await page.waitForFunction(text=>document.querySelector('#moshpit-tip')?.textContent.includes(text),chainHelp);
  const effectHeading=page.locator('.inspector-body .ih[tabindex]');
  const fullHelp=await effectHeading.getAttribute('title');
  assert.ok(fullHelp?.length>40,'effect explanation is preserved');
  assert.equal(await page.locator('.inspector-body .blurb').count(),0,'no duplicate explanatory paragraph');
  const dockBefore=await info.boundingBox();
  await effectHeading.hover();await page.waitForFunction(text=>document.querySelector('#moshpit-tip')?.textContent.includes(text),fullHelp);
  assert.ok((await helpText.innerText()).includes('double-click resets'));
  const dockAfter=await info.boundingBox();assert.equal(dockBefore.height,dockAfter.height,'help does not resize its dock');
  await helpText.hover();assert.ok((await helpText.innerText()).includes(fullHelp),'help stays while reading/copying');
  assert.equal(await helpText.evaluate(el=>getComputedStyle(el).userSelect),'text');
  await page.getByRole('button',{name:'Collapse Info pane',exact:true}).click();
  assert.ok(!(await helpText.isVisible()));
  await page.getByRole('button',{name:'Show Info pane',exact:true}).click();assert.ok(await helpText.isVisible());
  // Keyboard help must preserve unrelated accessible descriptions and React-updated titles.
  await effectHeading.evaluate(el=>el.setAttribute('aria-describedby','existing-description'));
  await effectHeading.focus();await page.waitForFunction(()=>document.querySelector('.inspector-body .ih').getAttribute('aria-describedby')?.includes('moshpit-tip'));
  assert.match(await effectHeading.getAttribute('aria-describedby'),/existing-description/);
  await page.keyboard.press('Escape');assert.equal(await effectHeading.getAttribute('aria-describedby'),'existing-description');
  await effectHeading.evaluate(el=>el.setAttribute('title','Updated explanation after a selection change.'));
  await helpText.hover();await effectHeading.hover();await page.waitForFunction(()=>document.querySelector('#moshpit-tip')?.textContent.includes('Updated explanation'));
  await effectHeading.evaluate((el,text)=>el.setAttribute('title',text),fullHelp);
  await helpText.hover();await effectHeading.hover();await page.waitForFunction(text=>document.querySelector('#moshpit-tip')?.textContent.includes(text),fullHelp);
  await shot('info-pane-1440');
  checks.push('Docked help preserves full effect explanations; no inspector prose duplicate; stable height, copyable retained text, collapse/reopen, keyboard descriptions and updated titles');
  const file=page.locator('.command-menu>summary').filter({hasText:/^File$/});
  await file.focus();await page.keyboard.press('Space');
  assert.ok(await page.getByRole('button',{name:'New project',exact:false}).isVisible());
  assert.equal((await ui()).playing,false);
  await page.keyboard.press('Tab');assert.match(await page.locator(':focus').innerText(),/New project/);
  await page.keyboard.press('Escape');assert.ok(await file.evaluate(el=>el===document.activeElement));
  assert.equal(await page.locator('.command-menu[open]').count(),0);
  await file.click();await page.locator('.command-menu>summary').filter({hasText:/^Edit$/}).click();
  assert.equal(await page.locator('.command-menu[open]').count(),1);
  await page.locator('.project-identity').click();assert.equal(await page.locator('.command-menu[open]').count(),0);
  checks.push('File keyboard/Tab/Escape, exclusive commands, outside close; Space never starts playback');
  const seek=page.locator('.preview-seek');
  for(const width of [1920,1440,1280]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>window.fixture.setUi({playhead:0}));const a=await seek.boundingBox();
    await page.evaluate(()=>window.fixture.setUi({playhead:172}));const b=await seek.boundingBox();
    assert.ok(Math.abs(a.x-b.x)<.5&&Math.abs(a.width-b.width)<.5,'seek must not resize with digits');
    const controls=await page.locator('.preview-buttons').boundingBox(),info=await page.locator('.preview-counters').boundingBox();
    const consoleBox=await transport.boundingBox();
    assert.ok(consoleBox.width<=900.5,'transport is bounded rather than filling a wide viewer');
    assert.ok(consoleBox.height<108,'compact controls give height back to the preview');
    assert.ok(controls.y>=consoleBox.y&&controls.y+controls.height<=consoleBox.y+consoleBox.height,'buttons stay inside console');
    assert.ok(info.y>=consoleBox.y&&info.x+info.width<=consoleBox.x+consoleBox.width+.5,'readouts stay inside console');
    for(const button of await transport.getByRole('button').all()){
      const box=await button.boundingBox();assert.ok(box.height>=32&&box.width>=30,'readable click targets');
    }
    assert.equal(await transport.evaluate(el=>el.scrollWidth>el.clientWidth),false,'no horizontal transport overflow');
    const preview=await page.locator('[data-viewer=left] .es-viewer-picture').boundingBox();
    assert.ok(preview.height>=130&&preview.y+preview.height<900,'visible preview');
    assert.ok(a.x>=0&&a.x+a.width<=width,'seek in viewport');
    await shot('desk-'+width);
  }
  checks.push('Stable seek edges at frames0/172 and widths1280/1440/1920; bounded compact controls, readable targets, no overflow; preview visible');
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('combobox',{name:'left viewer source'}).selectOption('A');
  const before=await ui();await transport.getByRole('button',{name:'Next frame',exact:true}).click();
  assert.equal((await ui()).loupes.A.frame,before.loupes.A.frame+1);assert.equal((await ui()).playhead,before.playhead);
  await page.getByRole('button',{name:'Split',exact:true}).click();
  await page.getByRole('combobox',{name:'right viewer source'}).selectOption('B');
  assert.equal(await page.locator('[data-viewer]').count(),2);await shot('split');
  await page.getByRole('button',{name:'Single',exact:true}).click();
  await page.getByRole('combobox',{name:'left viewer source'}).selectOption('program');
  checks.push('Source stepping and A/B split retain independent edit/source clocks');
  await transport.getByRole('button',{name:'Return to start',exact:true}).click();
  assert.equal((await ui()).playhead,0);
  await transport.getByRole('button',{name:'Next frame',exact:true}).click();assert.equal((await ui()).playhead,1);
  await transport.getByRole('button',{name:'Previous frame',exact:true}).click();assert.equal((await ui()).playhead,0);
  await transport.getByRole('button',{name:'Go to last frame',exact:true}).click();assert.ok((await ui()).playhead>0);
  await transport.getByRole('button',{name:'Play',exact:true}).click();assert.equal((await ui()).playing,true);
  await transport.getByRole('button',{name:'Pause',exact:true}).click();assert.equal((await ui()).playing,false);
  await seek.fill('42');assert.equal((await ui()).playhead,42);
  checks.push('Existing start/previous/next/end/play/pause/seek handlers retain edit behaviour');
  const graphBefore=await page.evaluate(()=>JSON.stringify(window.fixture.doc().timeline.blocks));
  await page.getByRole('button',{name:'Effects / recipes',exact:false}).click();
  await page.getByRole('textbox',{name:'Search effects'}).waitFor();await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>JSON.stringify(window.fixture.doc().timeline.blocks)),graphBefore);
  checks.push('Catalogue Escape returns without changing graph');
  await page.getByRole('button',{name:'Graph / routing',exact:true}).click();await page.locator('.task-routing').waitFor();
  assert.ok(await page.locator('[data-col=inspect] .inspector-chain').isVisible());
  for(const viewport of [{width:1440,height:900},{width:1280,height:800}]){
    await page.setViewportSize(viewport);
    const graph=page.locator('.task-routing');await graph.scrollIntoViewIfNeeded();
    const box=await graph.boundingBox();
    assert.ok(box.height>=220&&Math.min(box.y+box.height,viewport.height)-Math.max(0,box.y)>=220,'graph canvas needs usable visible height');
    await shot('graph-'+viewport.width);
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:'Modulation',exact:true}).first().click();
  assert.ok(await page.getByRole('button',{name:/New LFO/}).isVisible());
  await page.getByRole('button',{name:'Capture / recent',exact:true}).click();assert.ok(await page.getByLabel('Capture Edit preview').isVisible());
  await page.getByRole('button',{name:'Processing',exact:true}).click();
  checks.push('Central graph/modulation/capture accessible while resident inspector remains');
  await page.evaluate(()=>{window.fixture.six();window.fixture.transform()});
  const rotate=page.locator('[data-col=inspect]').getByRole('slider',{name:'Rotate',exact:true});
  const value=await rotate.getAttribute('aria-valuenow');await rotate.focus();await page.keyboard.press('ArrowRight');
  assert.notEqual(await rotate.getAttribute('aria-valuenow'),value);
  await page.getByRole('group',{name:'Edit history'}).count();
  await page.locator('.history-controls').getByRole('button',{name:'Undo',exact:true}).click();assert.equal(await rotate.getAttribute('aria-valuenow'),value);
  await page.getByRole('button',{name:'Animate Wet',exact:true}).click();await page.locator('.parameter-timeline').waitFor();await shot('animate');
  await page.getByRole('button',{name:'Close parameter lanes'}).click();
  checks.push('Inspector value edit, project Undo and real parameter animation retained');
  await page.evaluate(()=>window.fixture.legacy());
  assert.equal(await page.locator('[data-col=inspect] .ptabs button').count(),4);
  await page.locator('.command-menu>summary').filter({hasText:/^View$/}).click();
  await page.getByRole('button',{name:'Reset current layout',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.fixture.layouts().saved.some(l=>l.name.startsWith('Before reset ')&&l.layout.find(c=>c.id==='inspect').stacks[0].panes.length===4)));
  assert.equal(await page.locator('[data-col=inspect] .card').count(),1);
  checks.push('Custom four-tab layout loads unchanged; explicit reset saves full previous layout');
  await page.getByRole('navigation',{name:'Workspaces',exact:true}).getByRole('button',{name:/In/}).click();
  assert.equal(await page.locator('.desk-tools').count(),0);
  assert.equal(await page.getByRole('region',{name:'Info',exact:true}).count(),1,'one Info dock after workspace switch');
  await page.getByRole('navigation',{name:'Workspaces',exact:true}).getByRole('button',{name:/Mosh/}).click();
  await page.evaluate(()=>window.fixture.setUi({ws:'node'}));
  await page.locator('.focused-graph-workspace').waitFor();
  assert.equal(await page.getByRole('region',{name:'Info',exact:true}).count(),1,'graph overview retains full effect help');
  const graphHeading=page.locator('.composition-node-controls .ih[tabindex]');
  const graphHelp=await graphHeading.getAttribute('title');
  assert.ok(graphHelp?.length>40);
  await graphHeading.hover();await page.waitForFunction(text=>document.querySelector('#moshpit-tip')?.textContent.includes(text),graphHelp);
  for(const size of [{width:1440,height:900},{width:1280,height:800}]) {
    await page.setViewportSize(size);
    const box=await page.getByRole('region',{name:'Info',exact:true}).boundingBox();
    assert.ok(box.y>=0 && box.y+box.height<=size.height,'graph Info stays within viewport');
  }
  await shot('graph-info');
  await page.getByRole('button',{name:'Focus: block wiring',exact:true}).click();
  assert.equal(await page.getByRole('region',{name:'Info',exact:true}).count(),1,'graph detail has one Info pane');
  await page.getByRole('button',{name:'Return to overview',exact:true}).click();
  assert.equal(await page.getByRole('region',{name:'Info',exact:true}).count(),1,'graph overview restores one Info pane');
  checks.push('Graph overview keeps readable full effect help; one dock across overview/detail at two sizes');
  await page.evaluate(()=>window.fixture.setUi({ws:'mosh'}));
  await page.evaluate(()=>window.fixture.emptyProject());await shot('empty');
  assert.ok(await page.getByRole('button',{name:'Effects / recipes',exact:false}).isDisabled());
  checks.push('Context tools only in MOSH; empty project disables effect addition');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({status:'PASS',scope:'Actual React components with mock engine; not native/media/hardware acceptance',checks},null,2));
  console.log(JSON.stringify({out,checks}));
}catch(error){await shot('FAIL').catch(()=>{});await fs.writeFile(path.join(out,'RESULT.json'),JSON.stringify({status:'FAIL',checks,errors,error:String(error)},null,2));throw error;}
finally{await browser.close()}
