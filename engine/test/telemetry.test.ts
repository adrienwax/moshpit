import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FrameCost, dirBytes, parseNvidiaSmi } from '../src/telemetry/system';

describe('telemetry', () => {
  it('parses nvidia-smi csv (the real line from this machine)', () => {
    expect(parseNvidiaSmi('5, 1572, 12288, NVIDIA TITAN Xp COLLECTORS EDITION\r\n')).toEqual({ name: 'NVIDIA TITAN Xp COLLECTORS EDITION', load: 0.05, vramUsedMB: 1572, vramTotalMB: 12288 });
  });
  it('refuses garbage rather than inventing a figure', () => {
    expect(parseNvidiaSmi('')).toBeNull();
    expect(parseNvidiaSmi('[N/A], [N/A], [N/A], GPU')).toBeNull();
    expect(parseNvidiaSmi('5, 10, 0, GPU')).toBeNull();
  });
  it('sums a cache directory, nested, and treats a missing one as 0', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-tel-'));
    fs.writeFileSync(path.join(d, 'a.bin'), Buffer.alloc(1000));
    fs.mkdirSync(path.join(d, 'sub'));
    fs.writeFileSync(path.join(d, 'sub', 'b.bin'), Buffer.alloc(234));
    expect(await dirBytes(d)).toBe(1234);
    expect(await dirBytes(path.join(d, 'nope'))).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
  });
  it('frame cost is a rolling mean over its window', () => {
    const f = new FrameCost(3);
    expect(f.avgMs).toBeNull();
    for (const ms of [10, 20, 30, 40]) f.add(ms);
    expect(f.avgMs).toBe(30);
    expect(f.count).toBe(4);
  });
});
