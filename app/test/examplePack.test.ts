import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createExampleLibrary, installExamplePack, packPath } from '../electron/example-pack';

const roots: string[] = [];
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-examples-')); roots.push(root);
  const pack = path.join(root, 'pack'), user = path.join(root, 'user');
  const files: Record<string, string> = { 'media/source.mp4': 'source', 'previews/demo.mp4': 'preview', 'projects/demo.mosh': JSON.stringify({ resources: { sources: [{ path: 'pack://media/source.mp4' }], conforms: [{path:'pack://media/source.mp4', map:{args:['pack://media/source.mp4']}}] } }) };
  for (const [name, value] of Object.entries(files)) { const p = path.join(pack, name); await fs.mkdir(path.dirname(p), {recursive:true}); await fs.writeFile(p, value); }
  const manifest = { schemaVersion: 1, packId: 'test-v1', files: Object.entries(files).map(([p,b]) => ({path:p,sha256:hash(Buffer.from(b))})), examples:[{id:'starter-demo',title:'Demo',group:'mix',file:'projects/demo.mosh',preview:'previews/demo.mp4',seconds:6,hint:'Try changing the time'}] };
  await fs.writeFile(path.join(pack,'manifest.json'),JSON.stringify(manifest));
  return {root,pack,user,manifest};
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true}); });
describe('durable bundled examples', () => {
  it('materializes all nested references outside extraction and preserves saved-copy media after extraction removal', async () => {
    const {root,pack,user} = await fixture();
    const rows = await installExamplePack(pack,user);
    expect(rows[0].collection).toBe('bundled');
    const doc = JSON.parse(await fs.readFile(rows[0].file,'utf8'));
    expect(doc.resources.sources[0].path.startsWith(user)).toBe(true);
    expect(doc.resources.conforms[0].map.args[0]).toBe(doc.resources.sources[0].path);
    const copy = path.join(root,'saved-copy.mosh'); await fs.writeFile(copy,JSON.stringify(doc));
    await fs.rm(pack,{recursive:true});
    const reopened = JSON.parse(await fs.readFile(copy,'utf8'));
    expect(await fs.readFile(reopened.resources.sources[0].path,'utf8')).toBe('source');
    expect(await fs.readFile(rows[0].preview!,'utf8')).toBe('preview');
  });
  it('reuses the same durable paths and refuses to overwrite modified installed media',async()=>{
    const {pack,user}=await fixture();
    const first=await installExamplePack(pack,user), second=await installExamplePack(pack,user);
    expect(second).toEqual(first);
    await fs.writeFile(first[0].preview!,'owner modification');
    await expect(installExamplePack(pack,user)).rejects.toThrow('changed');
    expect(await fs.readFile(first[0].preview!,'utf8')).toBe('owner modification');
  });
  it.each(['../outside.mp4','C:/secret.mp4','media\\x.mp4','media/x.mp4:stream','media/con.mp4','media/x.','/absolute.mp4'])('rejects traversal or Windows alias %s',name=>{
    expect(()=>packPath(os.tmpdir(),name)).toThrow();
  });
  it('refuses a source changed after the manifest was pinned',async()=>{
    const {pack,user}=await fixture();await fs.writeFile(path.join(pack,'media/source.mp4'),'changed');
    await expect(installExamplePack(pack,user)).rejects.toThrow('check failed');
  });
  it('refuses unlisted project dependencies',async()=>{
    const {pack,user,manifest}=await fixture();const bytes=Buffer.from('{"path":"pack://media/missing.mp4"}');
    await fs.writeFile(path.join(pack,'projects/demo.mosh'),bytes);manifest.files[2].sha256=hash(bytes);
    await fs.writeFile(path.join(pack,'manifest.json'),JSON.stringify(manifest));
    await expect(installExamplePack(pack,user)).rejects.toThrow('unlisted');
  });
  it('keeps built-ins when the local index is invalid, and serves only registered previews',async()=>{
    const {pack,user}=await fixture();await fs.mkdir(path.join(user,'config'),{recursive:true});
    await fs.writeFile(path.join(user,'config/examples.json'),'not json');
    const library=createExampleLibrary(pack,user), result=await library.read();
    expect(result.examples).toHaveLength(1);expect(result.warning).toContain('local example index');
    expect(await library.allowsPreview(result.examples[0].preview!)).toBe(true);
    expect(await library.allowsPreview(result.examples[0].file)).toBe(false);
    expect(await library.allowsPreview(path.join(pack,'previews/demo.mp4'))).toBe(false);
  });
  it('merges owner entries without rewriting owner files and exposes missing projects',async()=>{
    const {pack,user,root}=await fixture();await fs.mkdir(path.join(user,'config'),{recursive:true});
    const owner={schemaVersion:1,examples:[{id:'my-local',title:'My local',group:'pixelord',file:path.join(root,'missing.mosh'),seconds:6,hint:'Local'}]};
    const file=path.join(user,'config/examples.json'), text=JSON.stringify(owner);await fs.writeFile(file,text);
    const result=await createExampleLibrary(pack,user).read();
    expect(result.examples).toHaveLength(2);expect(result.examples[1].collection).toBe('local');expect(result.examples[1].unavailable).toContain('not found');
    expect(await fs.readFile(file,'utf8')).toBe(text);
  });
  it('retries on the same library after a missing pack is restored',async()=>{
    const {pack,user,root}=await fixture();const parked=path.join(root,'parked-pack');
    await fs.rename(pack,parked);
    const library=createExampleLibrary(pack,user);
    expect((await library.read()).warning).toContain('Built-in examples');
    await fs.rename(parked,pack);
    const repaired=await library.read();
    expect(repaired.warning).toBeUndefined();expect(repaired.examples).toHaveLength(1);
  });

});
