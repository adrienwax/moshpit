import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const self=fileURLToPath(import.meta.url), [role, mode='normal']=process.argv.slice(2);
const record=()=>({role,pid:process.pid,temp:process.env.TEMP,tmp:process.env.TMP,run:process.env.EDENA_SCRATCH_RUN,artifacts:process.env.EDENA_ARTIFACTS_DIR,managed:process.env.EDENA_SCRATCH_MANAGED,args:process.argv.slice(4)});
const artifact=name=>path.join(process.env.EDENA_ARTIFACTS_DIR,name);
console.log(`scratch fixture stdout ${role}`);
console.error(`scratch fixture stderr ${role}`);
fs.writeFileSync(artifact(`${role}.json`),JSON.stringify(record()));
fs.writeFileSync(path.join(process.env.TEMP,`${role}.tmp`),'small scratch fixture');
if(role==='root') {
  if(mode==='failure') process.exit(7);
  const child=spawn(process.execPath,[self,'child',mode],{detached:true,stdio:'ignore'});
  child.unref();
} else if(role==='child') {
  const child=spawn(process.execPath,[self,'grandchild',mode],{detached:true,stdio:'ignore'});
  child.unref();
} else {
  setTimeout(()=>{
    fs.writeFileSync(artifact('grandchild-done.json'),JSON.stringify({tempExisted:fs.existsSync(process.env.TEMP),at:Date.now()}));
  },mode==='timeout'?2400:650);
}
