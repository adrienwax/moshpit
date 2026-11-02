// Installed-candidate startup test. Never controls CT or opens owner media.
import {_electron} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {requireScratchOutput} from './build-scratch/bootstrap.mjs';
const root=requireScratchOutput(process.env.KRAB_INSTALLER_TEST_ROOT || '');
const expectedVersion=process.env.KRAB_EXPECTED_VERSION || JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const kind=process.argv[2];assert.ok(['moshpit','ctserver'].includes(kind));
const name=kind==='moshpit'?'Moshpit KRAB Candidate':'CTserver KRAB Candidate';
const executablePath=path.join(root,`installed-${kind}`,`${name}.exe`);
const testRoot=fs.mkdtempSync(path.join(root,`smoke-${kind}-`));
const env={...process.env,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp')};
for(const key of Object.keys(env))if(/^(MOSHPIT_|WAXYCT_|ELECTRON_RUN_AS_NODE)/.test(key))delete env[key];
if(kind==='moshpit')Object.assign(env,{MOSHPIT_USER_DATA:path.join(testRoot,'profile'),MOSHPIT_ENGINE_CACHE:path.join(testRoot,'engine-cache'),MOSHPIT_LIBRARY:path.join(testRoot,'empty-media'),MOSHPIT_TEST_CLIPS:'',MOSHPIT_TEST_BACKGROUND:'1'});
else env.WAXYCT_HOME_CANDIDATE_ROOT=testRoot;
fs.mkdirSync(path.join(testRoot,'empty-media'));
const result={kind,executablePath,checks:[],errors:[],passed:false};
let app;
try {
 app=await _electron.launch({executablePath,env,timeout:30000});
 result.pid=app.process().pid;
 const state=await app.evaluate(({app})=>({name:app.getName(),version:app.getVersion(),userData:app.getPath('userData'),isPackaged:app.isPackaged}));
 result.state=state;
 assert.equal(state.name,name);assert.equal(state.version,expectedVersion);assert.equal(state.isPackaged,true);
 assert.ok(state.userData.toLowerCase().startsWith(testRoot.toLowerCase()+path.sep));result.checks.push('packaged identity and isolated settings');
 const page=await app.firstWindow({timeout:30000});page.on('pageerror',error=>result.errors.push(error.message)); result.failedRequests=[]; page.on('requestfailed',request=>result.failedRequests.push({url:request.url(),failure:request.failure()}));
 await page.waitForLoadState('domcontentloaded');
 if(kind==='moshpit')await page.locator('.topbar').waitFor({timeout:30000});
 else await page.getByRole('tab',{name:'Map',exact:true}).first().waitFor({timeout:30000});
 if(kind==='ctserver')await page.waitForFunction(version=>document.querySelector('#ver')?.textContent?.includes(version),expectedVersion,{timeout:20000}); result.title=await page.title();result.checks.push('renderer loaded and live version received');
 if(kind==='ctserver'){
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(testRoot,'router.json'),'utf8')),{port:9994,hostAuto:false});
  const config=JSON.parse(fs.readFileSync(path.join(testRoot,'private-profile','config','apps.json'),'utf8'));
  assert.equal(config.moshpit.exe,'Moshpit KRAB Candidate.exe');
  result.checks.push('manual ownership and candidate-only app routing');
 }
 await page.screenshot({path:path.join(root,'evidence',`${kind}-installed.png`),timeout:10000}).then(()=>result.checks.push('renderer screenshot captured'),error=>{result.screenshotError=error.message;});
 assert.deepEqual(result.errors,[]);result.passed=true;
}catch(error){result.error=String(error.stack||error);}
finally {
 if(app){
  const child=app.process();
  const closed=new Promise(resolve=>{if(child.exitCode!==null)resolve(true);else child.once('exit',()=>resolve(true));});
  await app.evaluate(({app})=>{setTimeout(()=>app.quit(),50);}).catch(error=>{result.quitRequestError=error.message;});
  result.normalExit=await Promise.race([closed,new Promise(resolve=>setTimeout(()=>resolve(false),20000))]);
  if(!result.normalExit){result.passed=false;result.error=(result.error||'')+' Normal exit timed out; no force-kill attempted.';}
 }
 fs.writeFileSync(path.join(root,'evidence',`${kind}-native-smoke.json`),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}
if(!result.passed)process.exitCode=1;
