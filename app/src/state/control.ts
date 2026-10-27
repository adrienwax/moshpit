import { rotaryCommandAmount, type CommandOptions, type ControlFeedback } from '@moshpit/core';
import { controlFeedback, createFeedbackPublisher } from './controlFeedback';
import type { ControlStatusBridge } from '../../control-status';
// CT Route B, UI side (INTERFACES.md · window.moshpitControl). The store publishes every
// snapshot with a generation that bumps when the graph shape or the active block changes (so a
// knob aimed at a node that no longer exists is rejected as stale — ControlContext). CT writes
// and commands come back here and land as ordinary undoable edits (L11: a knob writes the base).
import { asMoshpitError, MoshpitError, discoveryShape, parseTargetPath, type CommandId, type ParamValue } from '@moshpit/engine';
import type { WriteRequest, WriteReply } from '../../electron/control-requests';
import { commitControlWrite } from './controlWrite';
import { activeBlock, getDoc, isFrozen, projectStore, redo, selectBlock, selectNode, setBypass, setLfo, setMarks, setParam, toggleFreeze, undo } from './project';
import { queueRender, renderStore } from './render';
import { openDropped } from '../lib/osDrop';
import { setLoupe, setUi, setWs, uiStore, type WsId } from './ui';
import { frameRangeOf } from '../components/nodes';
import { toastError } from '../qol/qol';
import { blockStarts, timelineFrames } from '../lib/timeline';
import { BROWSE_COMMANDS, IN_ONLY_COMMANDS, dispatchBrowseCommand } from './browseControl';
import { toast } from '../qol/qol';

interface ControlBridge extends ControlStatusBridge {
  publish(doc: unknown, generation: number): void;
  workspace?(workspace: WsId): void;
  feedback?(snapshot: ControlFeedback): void;
  onCommit(fn: (m: { path: string; value: unknown }) => void): void;
  onWrite?(fn: (m: WriteRequest) => void): void;
  reply?(m: WriteReply): void;
  onCommand(fn: (m: { command: string } & CommandOptions) => void): void;
  onClients?(fn: (count: number) => void): void;
  onSelect?(fn: (m: { nodeId: string }) => void): void;
}
declare global {
  interface Window {
    moshpitControl?: ControlBridge;
  }
}

/** Graph shape + active block: what a CT address resolves against. */
// The same key the control host uses (control-host.ts): one function, so both sides agree when to re-discover.
const shapeOf = () => discoveryShape(getDoc());

function step(blockDelta: number) {
  const d = getDoc();
  const cur = activeBlock(d);
  const i = cur ? d.timeline.blocks.indexOf(cur) : -1;
  const next = d.timeline.blocks[Math.max(0, Math.min(d.timeline.blocks.length - 1, i + blockDelta))];
  if (!next) return;
  selectBlock(next.id);
  setUi({ playhead: blockStarts(d.timeline.blocks)[d.timeline.blocks.indexOf(next)] });
}

/** The slice target loupe's clip, as the I / O keys and mark.in / mark.out resolve it. */
function sliceClip() {
  const d = getDoc();
  const ui = uiStore.get();
  const l = ui.loupes[ui.sliceTarget];
  const src = d.resources.sources.find((s) => s.id === l.src) ?? d.resources.sources[ui.sliceTarget === 'A' ? 0 : Math.min(1, d.resources.sources.length - 1)];
  return { d, ui, l, src };
}

/** Legacy project-clip navigation also lands at the first frame, matching visible IN browsing. */
export function stepClip(delta: number) {
  const { d, ui, src } = sliceClip();
  if (!src) return;
  const all = d.resources.sources;
  const next = all[Math.max(0, Math.min(all.length - 1, all.indexOf(src) + delta))];
  if (next && next !== src) setLoupe(ui.sliceTarget, { src: next.id, frame: 0 });
}

/** M3 · IN page: move the slice clip's IN or OUT mark by `frames`. IN stays before OUT; nothing leaves the clip. */
export function nudgeMark(which: 'in' | 'out', frames: number) {
  const { d, src } = sliceClip();
  const m = src?.marks[0];
  if (!src || !m) return;
  const len = d.resources.conforms.find((c) => c.sourceId === src.id)?.frames ?? Infinity;
  if (which === 'in') setMarks(src.id, Math.max(0, Math.min(m.out - 1, m.in + frames)), m.out);
  else setMarks(src.id, m.in, Math.min(len, Math.max(m.in + 1, m.out + frames)));
}

function command(id: string, options?: CommandOptions) {
  const d = getDoc();
  const ui = uiStore.get();
  const b = activeBlock(d);
  if (BROWSE_COMMANDS.has(id) && (ui.ws === 'browse' || id.startsWith('source.') || IN_ONLY_COMMANDS.has(id))) {
    if (ui.ws !== 'browse' || !dispatchBrowseCommand(id, options)) toast('Open IN and choose a clip to use this control.', { kind: 'info' });
    return;
  }
  const amount = rotaryCommandAmount(id, options, d.settings?.fps ? d.settings.fps.num / d.settings.fps.den : 1);
  switch (id as CommandId) {
    case 'transport.play': return setUi({ playing: true });
    case 'transport.stop': return setUi({ playing: false });
    case 'transport.loop': return setUi({ playing: !ui.playing });
    case 'transport.prevFrame': return setUi({ playhead: Math.max(0, ui.playhead - amount) });
    case 'transport.nextFrame': return setUi({ playhead: Math.max(0, Math.min(timelineFrames(d.timeline.blocks) - 1, ui.playhead + amount)) });
    case 'mark.in':
    case 'mark.out': {
      // Marks follow the slice target loupe (A or B), like the I / O keys (Phase E: was A only).
      const l = ui.loupes[ui.sliceTarget];
      const f = Math.round(l.frame);
      const src = d.resources.sources.find((s) => s.id === l.src) ?? d.resources.sources[ui.sliceTarget === 'A' ? 0 : Math.min(1, d.resources.sources.length - 1)];
      if (!src) return;
      const m = src.marks[0];
      return id === 'mark.in' ? setMarks(src.id, f, Math.max(f + 1, m?.out ?? f + 1)) : setMarks(src.id, Math.min(m?.in ?? 0, f - 1), f);
    }
    case 'block.prev': return step(-amount);
    case 'block.next': return step(amount);
    case 'block.freeze':
    case 'block.unfreeze': {
      if (!b) return;
      const t = { kind: 'block' as const, blockId: b.id };
      if (isFrozen(d, t) === (id === 'block.freeze')) return; // already in the asked-for state
      return void toggleFreeze(t, frameRangeOf(d.timeline.blocks, b)).catch(toastError);
    }
    case 'workspace.browse':
    case 'workspace.mosh':
    case 'workspace.node':
    case 'workspace.render':
    case 'workspace.settings':
      return setWs(id.split('.')[1] as WsId);
    case 'clip.prev': return stepClip(-amount);
    case 'clip.next': return stepClip(amount);
    case 'mark.in.nudgeBack': return nudgeMark('in', -amount);
    case 'mark.in.nudgeForward': return nudgeMark('in', amount);
    case 'mark.out.nudgeBack': return nudgeMark('out', -amount);
    case 'mark.out.nudgeForward': return nudgeMark('out', amount);
    case 'render.start': return void queueRender();
    case 'edit.undo': return undo();
    case 'edit.redo': return redo();
    default:
      return toastError(new MoshpitError('CONTROL_STALE_TARGET', { command: id }));
  }
}

export function installControlBridge() {
  // e2e probe (read-only, like __moshpitPreview): what a CT command or select actually changed.
  // e2e: `drop` opens paths as an OS drop would (a test cannot make a folder File to drop).
  (window as { __moshpitState?: unknown }).__moshpitState = { doc: getDoc, ui: () => uiStore.get(), renders: () => renderStore.get(), drop: (paths: string[]) => openDropped(paths) };
  const c = window.moshpitControl;
  if (!c) return; // browser dev mode: no control server
  // Main checks feedback against its current workspace: navigation must arrive first.
  let lastWorkspace = uiStore.get().ws;
  c.workspace?.(lastWorkspace);
  uiStore.subscribe(() => {
    const next = uiStore.get().ws;
    if (next === lastWorkspace) return;
    lastWorkspace = next;
    c.workspace?.(next);
  });
  if (c.feedback) {
    let blocks = getDoc().timeline.blocks;
    let frames = timelineFrames(blocks);
    let selected = { index: blocks.indexOf(activeBlock(getDoc())!), count: blocks.length };
    const feedback = createFeedbackPublisher(() => {
      const ui = uiStore.get();
      return controlFeedback.snapshot(ui.ws, ui.playhead, frames, selected);
    }, value => c.feedback?.(value));
    controlFeedback.subscribe(feedback.changed);
    uiStore.subscribe(feedback.changed);
    projectStore.subscribe(() => {
      const next = getDoc().timeline.blocks;
      if (next !== blocks) { blocks = next; frames = timelineFrames(blocks); }
      selected = { index: blocks.indexOf(activeBlock(getDoc())!), count: blocks.length };
      feedback.changed();
    });
    feedback.changed();
  }
  // A renderer reload must not reuse its old generation 1 while a client is reconnecting.
  let generation = Date.now();
  let revision = 0;
  let shape = '';
  let queued = false;
  let sent: unknown = null;
  let clients = 0;
  // Phase 0.1a: each publish serialises the whole project across IPC. Only a document change counts
  // (history-only store updates do not), once per frame (16 ms) while a CT is connected, and at most
  // four times a second otherwise, which keeps main's snapshot fresh for the next client's hello.
  // A timer, not requestAnimationFrame: rAF stops in a minimised window, and the CT drives Moshpit
  // from behind other apps (main turns background throttling off while a client is connected).
  const send = () => {
    queued = false;
    const d = getDoc();
    if (d === sent) return;
    sent = d;
    syncGeneration();
    revision++;
    c.publish(d, generation);
  };
  const syncGeneration = () => {
    const s = shapeOf();
    if (s !== shape) { shape = s; generation++; }
  };
  const publish = () => {
    if (queued || getDoc() === sent) return;
    queued = true;
    setTimeout(send, clients > 0 ? 16 : 250);
  };
  c.onClients?.((n) => {
    const first = clients === 0 && n > 0;
    clients = n;
    if (first) (sent = null), send(); // a client arrived: give main the newest document now
  });
  projectStore.subscribe(publish);
  send();

  c.onWrite?.((request) => {
    try {
      syncGeneration(); // include edits not yet sent through the throttled mirror
      const value = commitControlWrite(request.write, generation, request.projectId, request.expiresAt);
      send(); // snapshot is queued before its ACK; no 16 ms window between acknowledged writes
      c.reply?.({ requestId: request.requestId, result: { value, generation, revision } });
    } catch (e) {
      send(); // stale clients receive the changed discovery generation as well as the error
      c.reply?.({ requestId: request.requestId, error: asMoshpitError(e).toJSON() });
    }
  });

  c.onCommit(({ path, value }) => {
    const t = parseTargetPath(path);
    try {
      if (!t) throw new MoshpitError('CONTROL_STALE_TARGET', { path });
      if (t.scope === 'node' && t.param === 'bypass') setBypass(t.blockId, t.nodeId, !!value);
      else if (t.scope === 'node') setParam(t.blockId, t.nodeId, t.param, value as ParamValue);
      else setLfo(t.lfoId, t.field === 'period' ? { period: Number(value) } : { phase: Number(value) }, `CT → LFO ${t.field}`);
    } catch (e) {
      toastError(e);
    }
  });
  c.onCommand(({ command: id, ...options }) => command(id, Object.keys(options).length ? options : undefined));
  c.onSelect?.(({ nodeId }) => {
    const b = activeBlock(getDoc());
    if (b) selectNode(b.id, nodeId as never);
  });
}
