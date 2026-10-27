import { rotaryCommandAmount, type CommandOptions } from '@moshpit/core';
import { transposeRange } from '../lib/sourceRange';
// CT commands address the visible IN selection, never a hidden A/B loupe.
type Handler = (command: string, options?: CommandOptions) => boolean;
let browse: Handler | undefined, transport: Handler | undefined, viewport: Handler | undefined;
export function registerBrowseControls(handler: Handler) {
  browse = handler;
  return () => { if (browse === handler) browse = undefined; };
}
export function registerBrowseTransport(handler: Handler) {
  transport = handler;
  return () => { if (transport === handler) transport = undefined; };
}
export function registerBrowseViewport(handler: Handler) {
  viewport = handler;
  return () => { if (viewport === handler) viewport = undefined; };
}
export const IN_ONLY_COMMANDS = new Set(['mark.range.nudgeBack', 'mark.range.nudgeForward',
  'folder.prev', 'folder.next', 'source.zoomOut', 'source.zoomIn', 'source.zoomFit']);
export const BROWSE_COMMANDS = new Set([...IN_ONLY_COMMANDS, 'clip.prev', 'clip.next', 'mark.in', 'mark.out',
  'mark.in.nudgeBack', 'mark.in.nudgeForward', 'mark.out.nudgeBack', 'mark.out.nudgeForward',
  'transport.play', 'transport.stop', 'transport.loop', 'transport.prevFrame', 'transport.nextFrame',
  'source.selectAll', 'source.sendA', 'source.sendB', 'source.addBlock']);
const FRAME_COMMANDS = new Set(['transport.prevFrame', 'transport.nextFrame']);
const invoke = (handler: Handler | undefined, command: string, options?: CommandOptions) => options ? handler?.(command, options) : handler?.(command);
export function dispatchBrowseCommand(command: string, options?: CommandOptions): boolean {
  // Selection and CT detents can arrive in the same React batch. Resolve frame steps from the
  // live library store, not the old track's props; it may still be showing the previous clip.
  if (FRAME_COMMANDS.has(command) && invoke(browse, command, options)) { transport?.('transport.stop'); return true; }
  return (command.startsWith('transport.') ? invoke(transport, command, options) : command.startsWith('source.zoom') ? invoke(viewport, command, options) : invoke(browse, command, options)) ?? false;
}
export function browseFrame(frame: number | undefined, frames: number): number {
  return Math.max(0, Math.min(Math.max(0, frames - 1), Number.isFinite(frame) ? Math.round(frame!) : 0));
}
/** Switching clips starts at frame zero; revisiting one never resurrects an old scrub position. */
export function selectBrowseClip(path: string, actions: { current(): string | undefined; stop(): void; reset(path: string): void; select(path: string): void }): void {
  if (!path || path === actions.current()) return;
  actions.stop();
  actions.reset(path);
  actions.select(path);
}
export interface BrowseSelection { path: string; frames: number; fps?: number; frame: number; marks: { in: number; out: number } | null; usable: boolean }
export interface BrowseActions {
  selection(): BrowseSelection | null;
  paths(): string[];
  select(path: string): void;
  seek?(path: string, frame: number): void;
  marks(path: string, value: { in: number; out: number }): void;
  send(which: 'A' | 'B', addBlock: boolean): void;
  notice(text: string): void;
  folderStep?(delta: number): void;
}
export function createBrowseCommands(actions: BrowseActions): Handler {
  return (command, options) => {
    if (!BROWSE_COMMANDS.has(command) || (command.startsWith('transport.') && !(FRAME_COMMANDS.has(command) && actions.seek)) || command.startsWith('source.zoom')) return false;
    if (command.startsWith('folder.')) { actions.folderStep?.((command === 'folder.next' ? 1 : -1) * rotaryCommandAmount(command, options)); return true; }
    const selected = actions.selection();
    if (!selected) { actions.notice('Choose a clip in IN first.'); return true; }
    const { path, marks } = selected, frames = Math.max(1, selected.frames);
    const frame = browseFrame(selected.frame, frames);
    const amount = rotaryCommandAmount(command, options, selected.fps);
    if (FRAME_COMMANDS.has(command)) {
      actions.seek!(path, browseFrame(frame + (command === 'transport.nextFrame' ? amount : -amount), frames));
    } else if (command.startsWith('clip.')) {
      const paths = actions.paths(), index = paths.indexOf(path);
      const next = paths[Math.max(0, Math.min(paths.length - 1, index + (command === 'clip.next' ? amount : -amount)))];
      if (next && next !== path) actions.select(next);
    } else if (command.startsWith('source.send') || command === 'source.addBlock') {
      if (!selected.usable) actions.notice('This clip cannot be imported. Choose a playable clip.');
      else if (!marks) actions.notice('Mark In and Out, or select the entire clip first.');
      else actions.send(command === 'source.sendB' ? 'B' : 'A', command === 'source.addBlock');
    } else {
      let next = marks ?? { in: 0, out: frames };
      if (command.startsWith('mark.range.')) {
        if (!marks) { actions.notice('Mark a range before moving it.'); return true; }
        next = transposeRange(marks, command.endsWith('Forward') ? amount : -amount, frames);
      } else if (command === 'source.selectAll') next = { in: 0, out: frames };
      else if (command === 'mark.in') next = { in: frame, out: Math.max(frame + 1, next.out) };
      else if (command === 'mark.out') next = { in: Math.min(next.in, Math.max(0, frame - 1)), out: Math.max(1, frame) };
      else {
        const which = command.startsWith('mark.in.') ? 'in' : 'out';
        const value = next[which] + (command.endsWith('Forward') ? amount : -amount);
        next = which === 'in' ? { ...next, in: Math.max(0, Math.min(next.out - 1, value)) } : { ...next, out: Math.min(frames, Math.max(next.in + 1, value)) };
      }
      actions.marks(path, next);
    }
    return true;
  };
}
