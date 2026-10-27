// The Moshpit side of the CT Route B integration (§7, CONTROL-PROTOCOL.md v1): a transport-
// agnostic hub for param discovery, continuous writes, discrete commands and feedback pushes.
// Message shapes follow waxyct's MOSHPIT-WIRE.md, reconciled in CONTROL-PROTOCOL.md. The CT is
// just a client of the same param namespace the LFOs and the UI use; nothing here is CT-specific,
// and Moshpit runs fully with no client attached (R6).

import { asMoshpitError, MoshpitError, COMMANDS, isRotaryCommand, CONTROL_WORKSPACES, type ControlFeedback, type CommandOptions, type CommandId, type ProjectDoc, type ParamValue } from '@moshpit/core';
import { applyControlWrite, type ControlWrite } from './params';
import { discover, defForTarget, type Selection } from './discovery';

export const PROTOCOL = 'moshpit-control';
export const VERSION = 1;
export const CAPS = ['discover', 'write', 'command', 'subscribe', 'value-push', 'resolved', 'ping', 'selection', 'select', 'rotary-command-mode.v1'] as const;
export const MAX_REPEAT = 10;
export const WORKSPACES = CONTROL_WORKSPACES;
export type ControlWorkspace = (typeof WORKSPACES)[number];
export const isControlWorkspace = (value: unknown): value is ControlWorkspace => typeof value === 'string' && (WORKSPACES as readonly string[]).includes(value);
export interface ControlWriteResult { value: ParamValue; generation: number; revision: number }

/** What the hub needs from whoever owns the project (main, relaying the UI's store). */
export interface ControlHost {
  /** The latest committed project, its control generation, and the active block. */
  snapshot(): { doc: ProjectDoc; generation: number; workspace?: ControlWorkspace; feedback?: ControlFeedback };
  /** Commit a new base value as an undoable edit (audit S6: hardware writes the base). */
  commit(path: string, value: ParamValue): void;
  /** IPC hosts evaluate relative writes against their authoritative store and settle after commit. */
  write?(write: ControlWrite): Promise<ControlWriteResult>;
  command(id: CommandId, options?: CommandOptions): void;
  /** Select a node of the active block in Moshpit's inspector (M1: the CT picked a slot). */
  select?(nodeId: string): void;
  /** How many clients are connected (Phase 0.1a: the UI mirrors every frame only while one is). */
  sessions?(count: number): void;
}

export interface Session {
  send(msg: unknown): void;
  close(): void;
  authed: boolean;
  subs: Set<string>;
}

/**
 * Feedback throttle (CONTROL-PROTOCOL.md "Value pushes"): per target, at most one push per
 * `intervalMs`; base edits are exact, while resolved animation must move by `epsilon` of its
 * range. The last base value always lands (trailing flush). An LFO-driven param at
 * frame rate becomes ≤ 20 pushes a second instead of 30–60.
 */
export class PushThrottle {
  private last = new Map<string, { at: number; value: unknown; resolved: unknown }>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private emit: (path: string, value: unknown, resolved: unknown) => void, private intervalMs = 50, private epsilon = 1 / 256, private now: () => number = () => Date.now()) {}

  offer(path: string, value: unknown, resolved: unknown, range: number | null): void {
    const prev = this.last.get(path);
    const moved = (a: unknown, b: unknown) => (typeof a === 'number' && typeof b === 'number' && range ? Math.abs(a - b) >= this.epsilon * range : a !== b);
    if (prev && prev.value === value && !moved(prev.resolved, resolved)) {
      clearTimeout(this.pending.get(path)); this.pending.delete(path); return;
    }
    const wait = prev ? prev.at + this.intervalMs - this.now() : 0;
    clearTimeout(this.pending.get(path));
    const fire = () => { this.pending.delete(path); this.last.set(path, { at: this.now(), value, resolved }); this.emit(path, value, resolved); };
    if (wait <= 0) fire(); else this.pending.set(path, setTimeout(fire, wait));
  }

  dispose(): void { for (const t of this.pending.values()) clearTimeout(t); this.pending.clear(); this.last.clear(); }
}

export class ControlHub {
  private sessions = new Set<Session>();
  private throttle: PushThrottle;
  private lastGeneration = -1;
  private lastSelection = 'null';
  private lastWorkspace: ControlWorkspace | undefined;
  private feedbackTimer?: ReturnType<typeof setTimeout>;
  private lastFeedback = '';
  constructor(private host: ControlHost, private token: string, throttleMs = 50) {
    this.throttle = new PushThrottle((path, value, resolved) => {
      for (const s of this.sessions) if (s.authed && s.subs.has(path)) s.send({ type: 'value', path, value, ...(resolved !== undefined ? { resolved } : {}) });
    }, throttleMs);
  }

  open(s: Session): void { this.sessions.add(s); this.host.sessions?.(this.sessions.size); }
  closed(s: Session): void { this.sessions.delete(s); this.host.sessions?.(this.sessions.size); }
  dispose(): void { this.throttle.dispose(); clearTimeout(this.feedbackTimer); }

  handle(s: Session, raw: string): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { s.send({ type: 'error', code: 'UNKNOWN_MESSAGE', error: 'not JSON' }); return; }
    const id = m.id;
    if (!s.authed) {
      if (m.type !== 'hello') { s.send({ type: 'error', id, code: 'NO_HELLO' }); s.close(); return; }
      if (m.protocol !== PROTOCOL || m.version !== VERSION) { s.send({ type: 'error', id, code: 'PROTOCOL_VERSION', error: `this Moshpit speaks ${PROTOCOL} v${VERSION}` }); s.close(); return; }
      const tok = String(m.token ?? '');
      if (tok.length !== this.token.length || ![...tok].every((c, i) => c === this.token[i])) { s.send({ type: 'error', id, code: 'NOT_AUTHORISED' }); s.close(); return; }
      s.authed = true;
      const { doc, workspace, feedback } = this.host.snapshot();
      s.send({ type: 'welcome', id, version: VERSION, project: { id: doc.id, name: doc.name }, caps: [...CAPS, ...(workspace ? ['workspace'] : []), ...(feedback ? ['ui-feedback.v1'] : [])], ...(workspace ? { workspace } : {}), ...(feedback ? { feedback } : {}) });
      return;
    }
    try {
      switch (m.type) {
        case 'ping': s.send({ type: 'pong', id }); return;
        case 'discover': { const { doc, generation, workspace, feedback } = this.host.snapshot(); s.send({ type: 'targets', id, ...discover(doc, generation), ...(workspace ? { workspace } : {}), ...(feedback ? { feedback } : {}) }); return; }
        case 'subscribe': {
          const paths = (m.paths as string[]) ?? [];
          for (const p of paths) s.subs.add(p);
          s.send({ type: 'subscribed', id, paths });
          const { doc, generation } = this.host.snapshot();
          for (const t of discover(doc, generation).targets) if (paths.includes(t.path)) s.send({ type: 'value', path: t.path, value: t.value });
          return;
        }
        case 'unsubscribe': for (const p of (m.paths as string[]) ?? []) s.subs.delete(p); s.send({ type: 'ack', id }); return;
        case 'write': {
          const w = m.write as ControlWrite;
          if (this.host.write) {
            if (!w || typeof w.target !== 'string') throw new MoshpitError('CONTROL_STALE_TARGET', { target: w?.target });
            void this.host.write({ ...w, source: 'ct' }).then((result) => {
              s.send({ type: 'ack', id, ...result });
              this.changed(w.target, result.value);
            }).catch((e) => {
              const err = asMoshpitError(e);
              s.send({ type: 'error', id, code: err.code, error: err.toJSON() });
            });
            return;
          }
          const { doc, generation } = this.host.snapshot();
          const r = defForTarget(doc, String(w?.target), generation);
          if (!r) throw new MoshpitError('CONTROL_STALE_TARGET', { target: w?.target });
          const value = applyControlWrite({ target: w.target, generation }, r.def, r.value, { ...w, source: 'ct' });
          this.host.commit(w.target, value);
          s.send({ type: 'ack', id, value });
          this.changed(w.target, value);
          return;
        }
        case 'command': {
          const c = String(m.command) as CommandId;
          if (!(COMMANDS as readonly string[]).includes(c)) throw new MoshpitError('PARAM_UNKNOWN', { command: c });
          if (m.mode !== undefined && !['normal', 'fine', 'coarse'].includes(m.mode as string)) throw new MoshpitError('PARAM_OUT_OF_RANGE', { command: c, mode: m.mode });
          const n = m.repeat === undefined ? 1 : m.repeat;
          if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_REPEAT) throw new MoshpitError('PARAM_OUT_OF_RANGE', { command: c, repeat: n });
          if (!isRotaryCommand(c) && (m.mode !== undefined || n !== 1)) throw new MoshpitError('PARAM_OUT_OF_RANGE', { command: c, reason: 'Only rotary step commands accept mode or repeat' });
          // Resolve the count once in the authoritative UI store: no N IPC messages per turn.
          this.host.command(c, isRotaryCommand(c) ? { mode: (m.mode ?? 'normal') as CommandOptions['mode'], repeat: n } : undefined);
          s.send({ type: 'ack', id, repeat: n });
          return;
        }
        case 'select': {
          // M1: by nodeId or by slot index (1-based), against the current generation like a write.
          const { doc, generation } = this.host.snapshot();
          if (m.generation !== undefined && m.generation !== generation) throw new MoshpitError('CONTROL_STALE_TARGET', { generation: m.generation });
          const d = discover(doc, generation);
          const slot = d.slots.find((x) => (m.nodeId !== undefined ? x.nodeId === m.nodeId : x.index === Number(m.slot)));
          if (!slot) throw new MoshpitError('CONTROL_STALE_TARGET', { nodeId: m.nodeId, slot: m.slot });
          this.host.select?.(slot.nodeId);
          s.send({ type: 'ack', id, selected: { nodeId: slot.nodeId, slot: slot.index } });
          return;
        }
        default: s.send({ type: 'error', id, code: 'UNKNOWN_MESSAGE' });
      }
    } catch (e) {
      const err = asMoshpitError(e);
      s.send({ type: 'error', id, code: err.code, error: err.toJSON() });
    }
  }

  /**
   * Any edit from anywhere (mouse, undo, the CT itself, an LFO tick with its resolved value):
   * pushed to subscribers through the throttle. `resolved` is the modulated value for the ring.
   */
  changed(path: string, value: unknown, resolved?: unknown, range: number | null = null): void {
    if (range === null) {
      const { doc, generation } = this.host.snapshot();
      const r = defForTarget(doc, path, generation);
      range = r && r.def.min !== undefined && r.def.max !== undefined ? r.def.max - r.def.min : null;
    }
    this.throttle.offer(path, value, resolved, range);
  }

  /** Session navigation is independent of the document and never changes control generation. */
  workspaceChanged(): void {
    const { workspace } = this.host.snapshot();
    if (!workspace || workspace === this.lastWorkspace) return;
    this.lastWorkspace = workspace;
    for (const s of this.sessions) if (s.authed) s.send({ type: 'workspace', workspace });
  }

  /** Latest complete UI state, at most 20Hz, with a trailing delivery after fast scrubs. */
  feedbackChanged(): void {
    if (this.feedbackTimer) return;
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = undefined;
      const { feedback } = this.host.snapshot();
      if (!feedback) return;
      const key = JSON.stringify(feedback);
      if (key === this.lastFeedback) return;
      this.lastFeedback = key;
      for (const s of this.sessions) if (s.authed) s.send({ type: 'ui-feedback', feedback });
    }, 50);
  }

  /** Moshpit's selection may have changed (any source: mouse, keyboard, a CT select): push it once per change (M1). */
  selectionChanged(): void {
    const { doc, generation } = this.host.snapshot();
    const sel: Selection | null = discover(doc, generation).selected;
    const key = JSON.stringify(sel);
    if (key === this.lastSelection) return;
    this.lastSelection = key;
    for (const s of this.sessions) if (s.authed) s.send({ type: 'selection', generation, selected: sel });
  }

  /** The graph or active block changed: tell clients to re-discover (once per generation). */
  structureChanged(): void {
    const { generation } = this.host.snapshot();
    if (generation === this.lastGeneration) return;
    // A fresh discovery owns every value. Old delayed pushes must not overwrite it after Undo.
    this.throttle.dispose();
    this.lastGeneration = generation;
    for (const s of this.sessions) if (s.authed) s.send({ type: 'targets-changed', generation });
  }
}
