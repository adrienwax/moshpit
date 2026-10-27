// L7 + C3: one addressing scheme every continuous modulator terminates at, and a separate
// command space for discrete input. They share addresses, not machinery.

import type { BlockId, LfoId, NodeId, ParamKey } from './ids';

/** Read-only UI state, independent of document revisions and parameter writes. */
export const CONTROL_WORKSPACES = ['home', 'browse', 'mosh', 'node', 'render', 'settings'] as const;
export type ControlWorkspace = (typeof CONTROL_WORKSPACES)[number];
export const CONTROL_FEEDBACK_KEYS = ['in', 'out', 'transpose', 'clip', 'folder', 'zoom', 'frame', 'block'] as const;
export type ControlFeedbackKey = (typeof CONTROL_FEEDBACK_KEYS)[number];
export interface ControlReadout { text: string; norm?: number }
export interface ControlFeedback {
  workspace: ControlWorkspace;
  /** Complete replacement, not a patch. Missing values are unavailable. */
  values: Partial<Record<ControlFeedbackKey, ControlReadout>>;
}

/** Bound the display-only IPC payload; no paths, arbitrary objects or nonfinite numbers. */
export function parseControlFeedback(input: unknown): ControlFeedback | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { workspace, values } = input as Record<string, unknown>;
  if (!(CONTROL_WORKSPACES as readonly unknown[]).includes(workspace) || !values || typeof values !== 'object' || Array.isArray(values)) return null;
  const clean: ControlFeedback['values'] = {};
  for (const key of CONTROL_FEEDBACK_KEYS) {
    const value = (values as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const { text, norm } = value as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim() || text.length > 48 || /[\x00-\x1f\x7f]/.test(text)) return null;
    if (norm !== undefined && (typeof norm !== 'number' || !Number.isFinite(norm) || norm < 0 || norm > 1)) return null;
    clean[key] = { text, ...(typeof norm === 'number' ? { norm } : {}) };
  }
  return { workspace: workspace as ControlWorkspace, values: clean };
}

/** A parameter of a node instance in a block's graph, or a project-scope modulator field. */
export type ControlTarget =
  | { scope: 'node'; blockId: BlockId; nodeId: NodeId; param: ParamKey }
  | { scope: 'lfo'; lfoId: LfoId; field: 'period' | 'phase' };

/** The hierarchical path form, for routing and display (L6). Stable across label renames. */
export function targetPath(t: ControlTarget): string {
  return t.scope === 'node' ? `/block/${t.blockId}/node/${t.nodeId}/param/${t.param}` : `/lfo/${t.lfoId}/${t.field}`;
}

export function parseTargetPath(path: string): ControlTarget | null {
  const n = /^\/block\/([^/]+)\/node\/([^/]+)\/param\/([^/]+)$/.exec(path);
  if (n) return { scope: 'node', blockId: n[1] as BlockId, nodeId: n[2] as NodeId, param: n[3] as ParamKey };
  const l = /^\/lfo\/([^/]+)\/(period|phase)$/.exec(path);
  if (l) return { scope: 'lfo', lfoId: l[1] as LfoId, field: l[2] as 'period' | 'phase' };
  return null;
}

/**
 * The control seam's context (ported from Moshpit 2.0 `ControlContext{targetId, generation}`).
 * A client aims at a target as of a generation; if the project moved on (the node was deleted,
 * the selection changed) the write is rejected as stale instead of landing somewhere wrong.
 */
export interface ControlContext {
  target: string;
  generation: number;
}

/** Discrete commands (C3). Keyboard, CT buttons and menu items all dispatch these ids. */
export const COMMANDS = [
  'transport.play', 'transport.stop', 'transport.loop', 'transport.prevFrame', 'transport.nextFrame',
  'mark.in', 'mark.out', 'block.prev', 'block.next', 'block.freeze', 'block.unfreeze',
  'workspace.browse', 'workspace.mosh', 'workspace.node', 'workspace.render', 'workspace.settings',
  'edit.undo', 'edit.redo',
  // Added in v1 (additive, CONTROL-PROTOCOL.md): the CT IN page (M3) and OUT page (M4).
  // `repeat` counts detents; rotary mode determines the distance per detent.
  'clip.prev', 'clip.next',
  'mark.in.nudgeBack', 'mark.in.nudgeForward', 'mark.out.nudgeBack', 'mark.out.nudgeForward',
  'mark.range.nudgeBack', 'mark.range.nudgeForward', 'folder.prev', 'folder.next',
  'source.zoomOut', 'source.zoomIn', 'source.zoomFit',
  'render.start',
  'source.selectAll', 'source.sendA', 'source.sendB', 'source.addBlock',
] as const;
export type CommandId = (typeof COMMANDS)[number];

/** Additive rotary-command-mode.v1: a bounded number of detents in one command/IPC message. */
export type CommandMode = 'normal' | 'fine' | 'coarse';
export interface CommandOptions { mode?: CommandMode; repeat?: number }
export const ROTARY_COMMANDS = [
  'transport.prevFrame', 'transport.nextFrame', 'clip.prev', 'clip.next', 'folder.prev', 'folder.next',
  'mark.in.nudgeBack', 'mark.in.nudgeForward', 'mark.out.nudgeBack', 'mark.out.nudgeForward',
  'mark.range.nudgeBack', 'mark.range.nudgeForward', 'source.zoomOut', 'source.zoomIn',
  'block.prev', 'block.next',
] as const;
export const isRotaryCommand = (command: string): boolean => (ROTARY_COMMANDS as readonly string[]).includes(command);

/** Magnitude only; the command supplies direction. Frames cannot become finer than one frame. */
export function rotaryCommandAmount(command: string, options: CommandOptions = {}, fps = 1): number {
  if (!isRotaryCommand(command)) return 1;
  const repeat = Number.isFinite(options.repeat) ? Math.max(1, Math.min(10, Math.round(options.repeat!))) : 1;
  if (options.mode !== 'coarse') return repeat;
  const unit = command.startsWith('source.zoom') ? 3
    : /^(clip|folder|block)\./.test(command) ? 5
    : Math.max(1, Math.round(Number.isFinite(fps) && fps > 0 ? fps : 1));
  return repeat * unit;
}
