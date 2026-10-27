// Isolated browser acceptance of the real MarkHandles component and shipped CSS.
// No engine, native app, hardware, installed config or media is opened.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'output/playwright/range-controls');
await fs.mkdir(out, { recursive: true });
await build({
  stdin: { sourcefile: 'range-fixture.tsx', resolveDir: root, loader: 'tsx', contents: `
    import React, {useState, useRef} from 'react';
    import {createRoot} from 'react-dom/client';
    import {MarkHandles} from './app/src/components/TimelineKit';
    function Fixture(){
      const [marks,setMarks] = useState({in:10,out:30}), [view,setView] = useState({start:0,len:100});
      const [identity,setIdentity] = useState('first'); const lane=useRef(null);
      window.fixture={marks, view, identity, setMarks, setView, setIdentity};
      return <><h1>Source range controls</h1><p>Actual component · isolated from the engine</p>
        <div className="scrub tall" ref={lane} style={{width:600}} onPointerDown={()=>window.scrubbed=(window.scrubbed||0)+1}>
          <MarkHandles track={lane} marks={marks} view={view} total={100} identity={identity} projectGesture={false} setMarks={(i,o)=>setMarks({in:i,out:o})}/>
          <div className="ph" style={{left:'20%'}} />
        </div><output>{marks.in} – {marks.out}</output>
        <div className="places" style={{width:260,marginTop:30}}>
          {[1,2].map(i=><div key={i} className="place browse-place"><button className="browse-place-open"><span className="ico">▱</span><span className="browse-place-label"><span>test clips</span><small>X:/ExampleMedia/generated-clips</small></span></button></div>)}
        </div>
      </>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` }, outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic',
  plugins: [{ name: 'isolated-project', setup(build) {
    build.onResolve({ filter: /state\/project$/ }, () => ({ path: 'project', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function beginGesture(){}; export function endGesture(){}; export function transact(fn){return fn()};' }));
  }}], logLevel: 'warning',
});
const css = (await Promise.all(['app/src/styles/prototype.css','app/src/styles/tokens.css','shared/ui/tokens.css'].map(p=>fs.readFile(path.join(root,p),'utf8')))).join('\n')
 + await fs.readFile(path.join(root,'app/src/ws/browse/browse.css'),'utf8')
 + await fs.readFile(path.join(root,'app/src/components/timelineRange.css'),'utf8');
await fs.writeFile(path.join(out,'index.html'), `<!doctype html><meta charset="utf-8"><style>${css}\nbody{display:block;padding:30px;overflow:auto;color:var(--txt);background:var(--bg);font:12px sans-serif}h1{font-size:18px}#root{width:auto;height:auto}output{display:block;margin-top:10px}</style><div id="root"></div><script src="fixture.js"></script>`);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
const checks=[];
try {
  await page.goto(pathToFileURL(path.join(out,'index.html')).href);
  const grip=page.getByRole('button',{name:'Move marked range'}); await grip.waitFor();
  const drag=async(dx,escape=false)=>{const r=await grip.boundingBox(); await page.mouse.move(r.x+r.width/2,r.y+r.height/2); await page.mouse.down(); await page.mouse.move(r.x+r.width/2+dx,r.y+r.height/2,{steps:4}); if(escape) await page.keyboard.press('Escape'); await page.mouse.up();};
  await drag(120); assert.deepEqual(await page.evaluate(()=>window.fixture.marks),{in:30,out:50});
  assert.equal(await page.evaluate(()=>window.scrubbed||0),0); checks.push('Range drag retains grab offset, duration and scrub isolation');
  await drag(90,true); assert.deepEqual(await page.evaluate(()=>window.fixture.marks),{in:30,out:50}); checks.push('Escape restores before-drag marks');
  await page.evaluate(()=>{window.fixture.setMarks({in:99,out:100});window.fixture.setView({start:90,len:10});});
  await page.waitForFunction(()=>window.fixture.marks.in===99 && window.fixture.view.len===10);
  const hit=await grip.evaluate(el=>{const r=el.getBoundingClientRect();return {w:r.width,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el||el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});
  assert.ok(hit.w>=22&&hit.hit); await drag(-120); assert.deepEqual(await page.evaluate(()=>window.fixture.marks),{in:97,out:98}); checks.push('One-frame zoomed grip stays reachable and uses view frame scale');
  await grip.focus(); await page.keyboard.press('ArrowLeft'); assert.deepEqual(await page.evaluate(()=>window.fixture.marks),{in:96,out:97}); checks.push('Keyboard range movement');
  await page.evaluate(()=>{window.fixture.setMarks({in:20,out:80});window.fixture.setView({start:40,len:20});});
  await page.waitForFunction(()=>window.fixture.view.start===40); await drag(60); assert.deepEqual(await page.evaluate(()=>window.fixture.marks),{in:22,out:82}); checks.push('Partly offscreen range preserves duration');
  const boxes=await page.locator('.browse-place').evaluateAll(rows=>rows.map(row=>{const r=row.getBoundingClientRect(), b=row.querySelector('small').getBoundingClientRect();return {top:r.top,bottom:r.bottom,contextBottom:b.bottom};}));
  assert.ok(boxes[0].contextBottom<=boxes[0].bottom && boxes[0].bottom<=boxes[1].top); checks.push('Two-line favourite context fits its own row at 260px');
  await page.evaluate(()=>{window.fixture.setMarks({in:10,out:30});window.fixture.setView({start:0,len:100});});
  await page.waitForFunction(()=>window.fixture.view.start===0);
  const edge=await page.getByRole('slider',{name:'IN',exact:true}).boundingBox();
  await page.mouse.move(edge.x+edge.width/2,edge.y+12); await page.mouse.down(); await page.mouse.move(edge.x+60,edge.y+12); await page.keyboard.press('Escape'); await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>window.fixture.marks),{in:10,out:30}); checks.push('Endpoint drag uses the same Escape restoration');
  const r=await grip.boundingBox(); await page.mouse.move(r.x+r.width/2,r.y+r.height/2); await page.mouse.down(); await page.mouse.move(r.x+r.width/2+60,r.y+r.height/2);
  await page.evaluate(()=>{window.fixture.setIdentity('second');window.fixture.setMarks({in:50,out:70});});
  await page.waitForFunction(()=>window.fixture.identity==='second');
  await page.mouse.move(r.x+r.width/2+120,r.y+r.height/2); await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>window.fixture.marks),{in:50,out:70}); checks.push('Source identity change cancels the old pointer gesture');
  await page.screenshot({path:path.join(out,'verified.png')});
  assert.deepEqual(errors,[]); await fs.writeFile(path.join(out,'result.json'),JSON.stringify({checks,errors},null,2));
  console.log(JSON.stringify({checks,errors,output:out},null,2));
} finally {await browser.close();}
