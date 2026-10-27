import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reused } from '../src/conform/conform';

describe('conform sidecar reuse after the cache dir moved', () => {
  it('takes each path from the file found now, not the one written in the sidecar', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-reuse-'));
    const master = path.join(d, 'x.mp4'), proxy = path.join(d, 'x-proxy.mp4'), side = path.join(d, 'x.json');
    fs.writeFileSync(master, 'm'); fs.writeFileSync(proxy, 'p');
    const old = 'C:\gone\cache\conform';
    fs.writeFileSync(side, JSON.stringify({ path: path.win32.join(old, 'x.mp4'), proxy: { path: path.win32.join(old, 'x-proxy.mp4') }, notes: [] }));
    const r = reused(side, [master, proxy], 'src1' as never)!;
    expect(r.path).toBe(master);
    expect(r.proxy!.path).toBe(proxy);
    expect(r.notes).toContain('REUSED');
    fs.rmSync(d, { recursive: true, force: true });
  });
});
