import { asMoshpitError, ERRORS, MoshpitError, type ErrorCode, type MoshpitErrorJSON } from '@moshpit/core';
import type { ControlWrite } from '../../engine/src/control/params';
import type { ControlWriteResult } from '../../engine/src/control/hub';

export interface WriteRequest { requestId: number; expiresAt: number; projectId: string; write: ControlWrite }
export interface WriteReply { requestId: number; result?: ControlWriteResult; error?: MoshpitErrorJSON }

/** Main waits for the store's result, never for an arbitrary snapshot delay. No automatic retries. */
export class ControlRequests {
  private serial = 0;
  private stopped = false;
  private pending = new Map<number, { resolve: (r: ControlWriteResult) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private send: (m: WriteRequest) => void, private timeoutMs = 3000) {}

  write(write: ControlWrite, projectId: string): Promise<ControlWriteResult> {
    if (this.stopped || this.pending.size >= 128) return Promise.reject(new MoshpitError('CT_DISCONNECTED', { why: 'control bridge unavailable or busy' }));
    const requestId = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new MoshpitError('CT_DISCONNECTED', { why: 'control commit timed out; not retried', requestId }));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ requestId, expiresAt: Date.now() + this.timeoutMs, projectId, write }); }
      catch (e) { clearTimeout(timer); this.pending.delete(requestId); reject(asMoshpitError(e)); }
    });
  }

  reply(m: WriteReply): void {
    const p = this.pending.get(m.requestId);
    if (!p) return; // a late response cannot acknowledge a timed-out write
    this.pending.delete(m.requestId); clearTimeout(p.timer);
    if (m.error) p.reject(new MoshpitError(m.error.code in ERRORS ? m.error.code as ErrorCode : 'INTERNAL', m.error.context));
    else if (m.result) p.resolve(m.result);
    else p.reject(new MoshpitError('INTERNAL', { why: 'empty control result' }));
  }

  close(): void {
    this.stopped = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new MoshpitError('CT_DISCONNECTED')); }
    this.pending.clear();
  }
  /** A fresh renderer snapshot proves the store bridge is back; request IDs are never reused. */
  resume(): void { this.stopped = false; }
}
