// Full renderer + real project/draft/history stores, normal browser mock engine.
// No desktop app, hardware, user config or footage is opened.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.join(root,'output/playwright/effect-gallery'); await fs.mkdir(out,{recursive:true});
const server=await createServer({configFile:path.join(root,'app/vite.config.mts'),configLoader:'runner',server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});
await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(String(e)));
try{
 await page.goto(server.resolvedUrls.local[0]);
 await page.waitForSelector('.topbar');
 await page.evaluate(async()=>{
   const project=await import('/src/state/project.ts'),ui=await import('/src/state/ui.ts');
   window.fixture={project,ui};ui.setUi({ws:'mosh',fxPanel:true});
 });
 const panel=page.getByRole('complementary',{name:'Effect browser'}),search=panel.getByRole('textbox',{name:'Search effects'});
 await panel.locator('.fxthumb canvas').first().waitFor();
 const geometry=await panel.evaluate(el=>{
   const card=el.querySelector('.op'),thumb=card.querySelector('.fxthumb'),name=card.querySelector('.nm');
   const tr=thumb.getBoundingClientRect(),nr=name.getBoundingClientRect();
   return{panel:el.getBoundingClientRect().width,thumb:tr.width,titleBelow:nr.top>=tr.bottom,cols:getComputedStyle(el.querySelector('.fxgallery-grid')).gridTemplateColumns.split(' ').length,descriptions:el.querySelectorAll('.fxgallery-grid .ob').length};
 });
 assert.equal(geometry.panel,660);assert.equal(geometry.cols,3);assert.ok(geometry.thumb>=190);assert.ok(geometry.titleBelow);assert.equal(geometry.descriptions,0);checks.push('660px three-column gallery: previews >=190px, titles below, no description rows');
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('.fxgallery-grid .fxthumb')).filter(el=>!el.querySelector('.prep')).length>=4);
 await page.screenshot({path:path.join(out,'01-gallery-1440.png')});
 const doc=()=>page.evaluate(()=>JSON.stringify(fixture.project.getDoc()));
 const before=await doc();
 await search.fill('Posterize');await panel.locator('.op').first().click();
 const detail=panel.getByRole('region',{name:'Tune Posterize'});
 await detail.locator('.fxdraft').waitFor();assert.equal(await doc(),before);
 assert.ok(await page.evaluate(()=>fixture.ui.uiStore.get().audition));checks.push('Selecting an effect auditions without project edits');
 const slider=detail.getByRole('slider').first(),initial=await slider.getAttribute('aria-valuenow');
 await slider.focus();await page.keyboard.press('ArrowRight');
 assert.notEqual(await slider.getAttribute('aria-valuenow'),initial);assert.equal(await doc(),before);
 await detail.getByRole('button',{name:'Reset draft'}).click();assert.equal(await slider.getAttribute('aria-valuenow'),initial);
 checks.push('Quick tuning changes only the audition; Reset restores draft');
 // User presets pass through the existing draft selector and survive compact rendering.
 const entryId=await page.evaluate(()=>fixture.ui.uiStore.get().audition.id);
 await page.evaluate(id=>fixture.ui.setSettings(s=>{s.effectPresets[id]=[{id:'gallery-preset',name:'My calm poster',params:{levels:7}}];}),entryId);
 const presets=detail.getByRole('combobox');await presets.selectOption('user:gallery-preset');
 assert.equal(await slider.getAttribute('aria-valuenow'),'7');assert.equal(await doc(),before);
 checks.push('Custom preset remains selectable and unapplied');
 const guidance=detail.locator('.fxguidance summary');await guidance.focus();await page.keyboard.press('Enter');
 assert.ok(await detail.locator('.fxguidance').evaluate(el=>el.open));assert.equal(await doc(),before);await page.keyboard.press('Enter');
 checks.push('Keyboard help disclosure does not accidentally add the effect');
 await page.screenshot({path:path.join(out,'02-quick-tune-1440.png')});
 await detail.getByRole('button',{name:/Add to Block/}).click();
 assert.notEqual(await doc(),before);await page.evaluate(()=>fixture.project.undo());assert.equal(await doc(),before);
 checks.push('Add commits tuned effect; one Undo restores exact document');
 await panel.locator('.op').first().click();await panel.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await doc(),before);
 await panel.getByRole('button',{name:'Favourite Posterize',exact:true}).first().click();
 assert.ok(await page.evaluate(id=>fixture.ui.settingsStore.get().effectFavs.includes(id),entryId));checks.push('Cancel and favourites remain independent of project edits');
 await search.fill('colour');const cards=panel.locator('.op');assert.ok(await cards.count()>5);await cards.first().click();
 const cardKey=async i=>cards.nth(i).getAttribute('data-row'),selectedKey=()=>panel.locator('.op.sel').getAttribute('data-row');
 for(const [key,index] of [['ArrowDown',3],['ArrowRight',4],['ArrowUp',1],['ArrowLeft',0]]){await page.keyboard.press(key);assert.equal(await selectedKey(),await cardKey(index));}
 await search.focus();await page.keyboard.press('ArrowLeft');assert.equal(await selectedKey(),await cardKey(0));
 await panel.getByRole('button',{name:'Cancel',exact:true}).click();checks.push('Card arrows follow three-column geometry; Search left/right retains text editing');
 await search.fill('');await panel.getByRole('button',{name:'Looks',exact:true}).click();
 await panel.locator('.op').first().click();await panel.locator('.fxgallery-detail .add').waitFor();
 assert.equal(await doc(),before);assert.ok(await panel.locator('.fxgallery-detail .fxdraft').count());
 await panel.getByRole('button',{name:'Cancel',exact:true}).click();checks.push('Recipe look still stages its editable draft without project mutation');
 await page.setViewportSize({width:980,height:720});await page.screenshot({path:path.join(out,'03-gallery-980.png')});
 assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth));
 await page.setViewportSize({width:560,height:760});await page.screenshot({path:path.join(out,'04-gallery-560.png')});
 assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth));
 assert.equal(await panel.locator('.fxgallery-grid').first().evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2);
 checks.push('980px and 560px viewports contain gallery; narrow layout has two columns');
 await search.focus();await page.keyboard.press('Escape');await page.waitForFunction(()=>!fixture.ui.uiStore.get().fxPanel);
 assert.equal(await page.evaluate(()=>fixture.ui.uiStore.get().audition??null),null);checks.push('Escape closes gallery and ends audition');
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({checks,geometry,errors,boundary:'Normal browser mock engine; not native rendering or hardware acceptance'},null,2));
 console.log(JSON.stringify({checks,geometry,errors,output:out},null,2));
}finally{await browser.close();await server.close();}
