// The GPU node contract every implementation fulfils (§6): state as Targets, reset/resumed,
// dispose, spillToDisk / restoreFromDisk. Its own module so implementations in several files can
// extend it without an import cycle.

import * as fs from 'node:fs';
import type { NodeDef } from '@moshpit/core';
import type { GL2Backend, Target } from './backend';

export interface GpuNode {
  readonly def: NodeDef;
  /** Targets a checkpoint must snapshot to resume this node, in a fixed order. */
  readonly state: readonly Target[];
  /** Back to the declared initial state (L10). Called at every block-repetition start (S1). */
  reset(): void;
  /** Called after `state` was refilled from a checkpoint or from disk. */
  resumed(): void;
  render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void;
  dispose(): void;
  spillToDisk(file: string): void;
  restoreFromDisk(file: string): void;
}

export abstract class Base implements GpuNode {
  abstract readonly def: NodeDef;
  state: Target[] = [];
  protected owned: Target[] = [];
  constructor(protected be: GL2Backend, protected w: number, protected h: number) {}
  protected own(t: Target): Target { this.owned.push(t); return t; }
  reset(): void {}
  resumed(): void {}
  abstract render(inputs: readonly (Target | null)[], out: Target, u: Float32Array): void;
  dispose(): void { for (const t of this.owned) this.be.release(t); this.owned = []; this.state = []; }
  spillToDisk(file: string): void {
    const buf = new Float32Array(this.w * this.h * 4), fd = fs.openSync(file, 'w');
    try { for (const t of this.state) { this.be.readFloat(t, buf); fs.writeSync(fd, new Uint8Array(buf.buffer)); } } finally { fs.closeSync(fd); }
  }
  restoreFromDisk(file: string): void {
    const buf = new Float32Array(this.w * this.h * 4), fd = fs.openSync(file, 'r');
    try { this.state.forEach((t, i) => { fs.readSync(fd, new Uint8Array(buf.buffer), 0, buf.byteLength, i * buf.byteLength); this.be.uploadFloat(t, buf); }); } finally { fs.closeSync(fd); }
    this.resumed();
  }
}

