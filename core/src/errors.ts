// L26 / plan §1d: every failure is a structured error with a stable code, a plain message and
// a suggested fix. Raw causes go to the log, never to the user's face. Tests assert the code,
// not the English.

export type Severity = 'info' | 'warning' | 'error' | 'fatal';

interface Entry {
  severity: Severity;
  message: string;
  fix: string;
}

/**
 * The catalogue. One row per code; the user guide's error table is generated from this. An
 * entry with no fix is a bug, so `fix` is not optional.
 */
export const ERRORS = {
  MEDIA_FILE_MISSING: { severity: 'error', message: 'The media file could not be found.', fix: 'Relink the clip to its new location, or remove it from the project.' },
  MEDIA_UNREADABLE: { severity: 'error', message: 'The media file could not be read as video.', fix: 'Check the file plays in another player; re-export it as H.264 or ProRes and import that.' },
  DECODE_UNSUPPORTED_CODEC: { severity: 'error', message: 'This clip uses a codec that cannot be frame-moshed directly.', fix: 'Conform it on import; Moshpit converts it to the moshable H.264 form.' },
  CONFORM_FAILED: { severity: 'error', message: 'Converting the clip to the moshable form failed.', fix: 'Check the clip plays elsewhere and that there is free disk space, then retry the import.' },
  CONFORM_CHANGED: { severity: 'warning', message: 'This clip conforms differently than when the project was saved (≈).', fix: 'The pinned original conform is kept. Re-conform only if you want the new result.' },
  PREVIEW_UNSUPPORTED: { severity: 'warning', message: 'This file cannot be scrubbed live here.', fix: 'The browser shows its filmstrip instead; importing it conforms it as usual.' },
  CONFORM_PENDING: { severity: 'warning', message: 'This clip is still finishing its full-quality conform.', fix: 'It runs in the background and usually takes under a minute per minute of 1080p footage; this works as soon as it finishes.' },
  CONFORM_FFMPEG_MISSING: { severity: 'error', message: 'ffmpeg was not found, so clips cannot be conformed.', fix: 'Set the ffmpeg path in Settings → App, or install a full ffmpeg build.' },
  CONFORM_NOT_MOSHABLE: { severity: 'warning', message: 'This clip can be played and used in effect graphs, but not moshed.', fix: 'It is a decode-only fallback. Re-import it after converting to H.264 if you want to mosh it.' },
  HDR_TONEMAPPED: { severity: 'info', message: 'This HDR clip was tone-mapped to standard range on import.', fix: 'Nothing to do. Colours may differ slightly from the HDR original.' },
  ALPHA_DROPPED: { severity: 'warning', message: 'This clip has an alpha channel, which the moshable form cannot carry.', fix: 'Transparency is lost on import. Keep the original for any alpha work outside Moshpit.' },
  BITSTREAM_PROFILE_UNSUPPORTED: { severity: 'error', message: 'The encoded stream is not in the moshable form (Main profile, no B-frames).', fix: 'Re-conform the clip; the conform produces the required form.' },
  BITSTREAM_REORDER_CROSSES_KEYFRAME: { severity: 'error', message: 'A reorder window crosses a keyframe.', fix: 'Shorten the window so it sits inside one GOP, or move it.' },
  BITSTREAM_SPLICE_INCOMPATIBLE: { severity: 'error', message: 'Two clips on the timeline were conformed with different settings and cannot be joined in the encoded stream.', fix: 'Re-conform both clips at the project working size.' },
  TIMELINE_EMPTY: { severity: 'info', message: 'The timeline has no blocks.', fix: 'Drag a clip or a slice onto the edit timeline.' },
  TIMELINE_NO_PICTURE: { severity: 'error', message: 'The first block must be a picture block: a mosh needs a picture to smear.', fix: 'Set the first block to Picture, or move a picture block to the start.' },
  RANGE_INVALID: { severity: 'error', message: 'That frame range is outside the timeline.', fix: 'Pick frames between the start and the end of the timeline.' },
  SLICE_RANGE_INVALID: { severity: 'error', message: 'That selection cannot be cut from the clip: it is empty or starts after the clip ends.', fix: 'Mark an IN before an OUT inside the clip, then send it again.' },
  BLOCK_RANGE_INVALID: { severity: 'error', message: 'A block\'s in/out range is outside its clip.', fix: 'Trim the block back inside the clip, or relink the clip.' },
  GRAPH_TYPE_MISMATCH: { severity: 'error', message: 'Two ports with incompatible types are connected.', fix: 'Remove the wire, or insert a conversion node between them.' },
  GRAPH_PORT_OCCUPIED: { severity: 'error', message: 'That input already has a wire.', fix: 'Remove the existing wire first, or use a Mix node to combine both.' },
  GRAPH_REQUIRED_INPUT: { severity: 'error', message: 'A required input is not connected.', fix: 'Wire something into it, or remove the node.' },
  GRAPH_CYCLE: { severity: 'error', message: 'The graph has a loop that does not go through a Delay node.', fix: 'Insert a Delay node in the loop; it reads the previous frame and breaks the cycle.' },
  CONTAINER_INVALID: { severity: 'error', message: 'A container in this block is broken: it needs exactly one Group input and one Group output, and every output wired inside.', fix: 'Open the container and wire its Group output, or unpack it into plain nodes.' },
  CONTAINER_NESTED: { severity: 'error', message: 'A container holds another container. Containers nest one level only.', fix: 'Unpack the inner container (or the outer one) so only one level remains.' },
  GRAPH_SECOND_DECODE: { severity: 'error', message: 'This block would decode its stream twice: the Source (or a Mosh node) feeds an effect directly as well as the Mosh chain.', fix: 'Feed the effect from the Decode node (Feed from Decode does it in one click), or give the clean picture its own block.' },
  GRAPH_DOMAIN_ORDER: { severity: 'error', message: 'An encoded-domain node sits after the decode boundary.', fix: 'Bitstream (Mosh) nodes must come before any effect. Move it next to the source.' },
  GRAPH_NO_OUTPUT: { severity: 'error', message: 'The block graph has no output node.', fix: 'Add an Output node and wire the last effect into it.' },
  NODE_UNKNOWN_KIND: { severity: 'warning', message: 'This node comes from a newer or removed version of Moshpit.', fix: 'It passes its input through and its settings are kept. Update Moshpit, or replace the node.' },
  NODE_LEGACY: { severity: 'warning', message: 'This node is an older version; it runs, but its settings are locked.', fix: 'Use Migrate to upgrade it; you will see a before/after diff first.' },
  NODE_CARRY_STATE_UNAVAILABLE: { severity: 'warning', message: 'Carrying feedback state across a block boundary is not available yet.', fix: 'State resets at the block start. Merge the blocks if you need one continuous trail.' },
  PARAM_UNKNOWN: { severity: 'error', message: 'That parameter does not exist on this node.', fix: 'The node may have been replaced; reselect it and try again.' },
  PARAM_OUT_OF_RANGE: { severity: 'error', message: 'That value is outside the parameter\'s range.', fix: 'Use a value inside the range shown on the control.' },
  RECIPE_INVALID: { severity: 'error', message: 'That look could not be read.', fix: 'Check it is a look saved by Moshpit 3.2 or later; recipes from Moshpit 2.0 hold macro values, not a node graph.' },
  CONTROL_STALE_TARGET: { severity: 'info', message: 'The control was aimed at something that has since changed.', fix: 'Touch the control again; it now follows the current selection.' },
  GPU_UNAVAILABLE: { severity: 'fatal', message: 'WebGL2 with float render targets is not available on this GPU.', fix: 'Update the graphics driver, or run Moshpit on a machine with a newer GPU.' },
  GPU_VRAM_EXCEEDED: { severity: 'error', message: 'This graph needs more GPU memory than the budget allows.', fix: 'Freeze an upstream block, remove a feedback node, or lower the working resolution.' },
  GPU_SHADER_COMPILE: { severity: 'fatal', message: 'A built-in shader failed to compile on this GPU.', fix: 'Update the graphics driver. Copy the error details for a bug report.' },
  DECODE_FAILED: { severity: 'error', message: 'The video decoder stopped on a frame it could not read.', fix: 'Re-conform the clip. If it keeps happening, copy the error details for a bug report.' },
  DECODE_FRAMES_WITHHELD: { severity: 'error', message: 'The decoder skipped frames in the moshed stream.', fix: 'This is a bitstream bug. Copy the error details; freezing the range avoids it for now.' },
  FREEZE_CACHE_CORRUPT: { severity: 'warning', message: 'A frozen render on disk is damaged.', fix: 'It will be re-rendered from the graph; nothing is lost.' },
  FREEZE_STALE: { severity: 'info', message: 'This freeze is out of date with the graph; it still plays the old render.', fix: 'Re-freeze to update it. Export always re-renders stale freezes.' },
  EXPORT_DISK_FULL: { severity: 'error', message: 'Export stopped because the disk is full.', fix: 'Free space or choose another drive. Your project is unchanged.' },
  EXPORT_EXISTS: { severity: 'error', message: 'A file with that name already exists.', fix: 'Pick another name; Moshpit never overwrites an export.' },
  SOURCE_PROTECTED: { severity: 'error', message: 'That path is one of your source files. Moshpit never writes to a source.', fix: 'Render to another file or folder; your footage is read-only to Moshpit.' },
  EXPORT_FAILED: { severity: 'error', message: 'The export did not finish.', fix: 'Copy the error details; the project is unchanged and you can retry.' },
  ENCODER_UNAVAILABLE: { severity: 'error', message: 'No software H.264 encoder accepted this size.', fix: 'Use an even width and height, or a smaller export size.' },
  PROJECT_PARSE: { severity: 'error', message: 'The project file is not valid.', fix: 'Open the autosave recovery copy instead, or restore from a backup.' },
  PROJECT_TOO_NEW: { severity: 'warning', message: 'This project was saved by a newer Moshpit.', fix: 'Parts this version does not know are kept untouched and saved back unchanged.' },
  PROJECT_MIGRATION_FAILED: { severity: 'error', message: 'Upgrading this project to the current format failed.', fix: 'The original file is untouched. Copy the error details for a bug report.' },
  JOB_PROCESS_CRASHED: { severity: 'error', message: 'The background job process (import, conform) stopped unexpectedly and was restarted.', fix: 'Your project is safe. Retry the import; if the same file repeats it, re-export that file as H.264 and import the copy.' },
  WORKER_CRASHED: { severity: 'error', message: 'The render engine stopped unexpectedly. Recovery is starting.', fix: 'Your edits remain in the editor. If the preview stays frozen, save the project and reopen Moshpit.' },
  CT_DISCONNECTED: { severity: 'info', message: 'Lost the control surface connection.', fix: 'Moshpit keeps working. Reconnect the CT and it re-links automatically.' },
  EXPRESSION_INVALID: { severity: 'error', message: 'That expression could not be read.', fix: 'Check brackets and names; only maths, time, beat, frame, lfo() and noise() are allowed.' },
  INTERNAL: { severity: 'fatal', message: 'Something inside Moshpit went wrong.', fix: 'Copy the error details for a bug report. Your project file is unchanged.' },
} as const satisfies Record<string, Entry>;

export type ErrorCode = keyof typeof ERRORS;

export class MoshpitError extends Error {
  readonly code: ErrorCode;
  readonly humanMessage: string;
  readonly suggestedFix: string;
  readonly severity: Severity;
  readonly context: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, context: Record<string, unknown> = {}, cause?: unknown, humanMessage?: string) {
    const e: Entry = ERRORS[code];
    super(`${code}: ${humanMessage ?? e.message}`);
    this.name = 'MoshpitError';
    this.code = code;
    this.humanMessage = humanMessage ?? e.message;
    this.suggestedFix = e.fix;
    this.severity = e.severity;
    this.context = context;
    this.cause = cause;
  }

  /** The "copy error details" payload. Plain JSON: it crosses IPC and goes into bug reports. */
  toJSON() {
    return {
      code: this.code, humanMessage: this.humanMessage, suggestedFix: this.suggestedFix, severity: this.severity,
      context: this.context, cause: this.cause instanceof Error ? `${this.cause.name}: ${this.cause.message}` : this.cause === undefined ? undefined : String(this.cause),
    };
  }
}

export type MoshpitErrorJSON = ReturnType<MoshpitError['toJSON']>;

/** Anything thrown becomes a MoshpitError at a boundary; a raw Error is wrapped as INTERNAL. */
export function asMoshpitError(e: unknown, context: Record<string, unknown> = {}): MoshpitError {
  return e instanceof MoshpitError ? e : new MoshpitError('INTERNAL', context, e);
}

export const fail = (code: ErrorCode, context: Record<string, unknown> = {}, cause?: unknown): never => {
  throw new MoshpitError(code, context, cause);
};
