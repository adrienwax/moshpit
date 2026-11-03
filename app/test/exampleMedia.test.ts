import { expect, it, vi } from 'vitest';
import path from 'node:path';
// These are pure path/range checks; importing Electron must not install its binary.
vi.mock('electron', () => ({ protocol: {} }));
import { resolveMediaRequest } from '../electron/protocol';
it('serves only the preview root or an explicitly registered example preview',async()=>{
  const root=path.resolve('preview'), external=path.resolve('examples/demo.mp4');
  const allowed=async(file:string)=>file===external;
  expect(await resolveMediaRequest(path.join(root,'capture.mp4'),root,allowed)).toBe(path.join(root,'capture.mp4'));
  expect(await resolveMediaRequest(external,root,allowed)).toBe(external);
  expect(await resolveMediaRequest(path.resolve('examples/private.json'),root,allowed)).toBeNull();
  expect(await resolveMediaRequest('../examples/demo.mp4',root,allowed)).toBeNull();
  expect(await resolveMediaRequest(external,root,async()=>false)).toBeNull();
});
