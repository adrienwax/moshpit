// System telemetry for the HUD (visual language §12.8): GPU load + VRAM, and the size of the
// engine's disk cache. Node-side, sampled by the render worker and pushed to the UI on a throttle.
// Honest by construction: a figure the machine cannot report is null (shown "n/a"), never guessed.
//
// GPU: nvidia-smi ships with every NVIDIA driver and reads the real counters; Chromium exposes no
// VRAM or load to a page. Other vendors report null until a reader is added for them.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GpuSample {
  name: string;
  /** 0..1, the GPU's own utilisation counter. */
  load: number;
  vramUsedMB: number;
  vramTotalMB: number;
}

/** Parse `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(out: string): GpuSample | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const [load, used, total, ...name] = line.split(',').map((s) => s.trim());
  const n = [Number(load), Number(used), Number(total)];
  if (n.some((x) => !Number.isFinite(x)) || n[2] <= 0) return null;
  return { name: name.join(',').trim(), load: n[0] / 100, vramUsedMB: n[1], vramTotalMB: n[2] };
}

let smiMissing = false;
/** One GPU sample, or null (no NVIDIA tool here — remembered, so it is not retried every tick). */
export function sampleGpu(): Promise<GpuSample | null> {
  if (smiMissing) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total,name', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') smiMissing = true;
        return resolve(null);
      }
      resolve(parseNvidiaSmi(String(stdout)));
    });
  });
}

/** Total bytes under `dir` (the conform / proxy / freeze / filmstrip cache). Missing dir = 0. */
export async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let names: string[];
    try { names = await fs.promises.readdir(d); } catch { return; }
    // stat, not Dirent: in Electron's renderer (the render worker) readdir's Dirents reported real
    // folders as non-directories, so the walk counted 28 KB of a 4 MB cache (measured 2026-10-07).
    await Promise.all(names.map(async (n) => {
      const p = path.join(d, n);
      try {
        const st = await fs.promises.stat(p);
        if (st.isDirectory()) return walk(p);
        total += st.size;
      } catch { /* vanished mid-walk */ }
    }));
  };
  await walk(dir);
  return total;
}

/** Rolling frame-render cost: the engine's time per served frame, the HUD's "GPU frame" figure. */
export class FrameCost {
  private ms: number[] = [];
  private served = 0;
  constructor(private readonly window = 30) {}
  add(ms: number): void {
    this.served++;
    this.ms.push(ms);
    if (this.ms.length > this.window) this.ms.shift();
  }
  get avgMs(): number | null { return this.ms.length ? this.ms.reduce((a, b) => a + b, 0) / this.ms.length : null; }
  get count(): number { return this.served; }
}
