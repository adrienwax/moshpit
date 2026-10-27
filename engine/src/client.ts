// Moved from app/src/engine/EngineClient.ts (UI lane, E3) so the seam lives with the engine.
// The UI lane re-points its imports here and deletes its copy when ready.
// The seam between the UI lane (/app) and the engine lane (/engine).
//
// Rules both sides meet:
//  - The app owns the ProjectDoc (L24: one graph store, React holds projections only). Every
//    committed edit is pushed with updateProject(); the engine compiles from that snapshot and
//    never mutates it.
//  - Every failure rejects with a MoshpitError (L26), never a raw Error or a string.
//  - Long work returns a Task so the UI can show progress and cancel.
//
import type {
  BlockGraph, BlockId, Chapter, ConformedSource, ConformQuality, ExportConfig, FreezeRecord, FreezeTarget, ImplState,
  MoshpitErrorJSON, NodeDef, NodeId, ProjectDoc, SourceClip, SourceId, SourceProbe, SourceRange,
} from '@moshpit/core';

/** What a viewer asks to see. */
export type FrameTarget =
  /** A clip's own conformed frame: loupes, browse preview, chapter thumbs. */
  | { kind: 'source'; sourceId: SourceId; frame: number }
  /** TD-style per-node viewer: the picture at this node, not the final render. `frame` is a timeline frame, not block-local. */
  | { kind: 'node'; blockId: BlockId; nodeId: NodeId; frame: number }
  /** The timeline's final output at a timeline frame. */
  | { kind: 'output'; frame: number }
  /**
   * Phase 2.2 / 2.3: the timeline's output with ONE block's graph swapped for `graph` (an effect
   * auditioned, a thumbnail). Rendered on its own slot; the project, its history and its freezes
   * never see it.
   */
  | { kind: 'trial'; blockId: BlockId; graph: BlockGraph; frame: number };

export interface FrameResult {
  image: ImageBitmap;
  /** L18: EXACT, or PROXY (shown as ≈). UNAVAILABLE rejects instead. */
  state: Exclude<ImplState, 'UNAVAILABLE'>;
  /** How the frame was obtained, in words, e.g. "I-frame · exact", "P-frame · est". */
  route: string;
  /** L25: set when a freeze served this frame. A stale freeze still plays. */
  freeze?: 'fresh' | 'stale';
}

export interface Task<T> {
  promise: Promise<T>;
  cancel(): void;
}

export interface ImportProgress {
  /** Proxy-first: 'probe' then 'proxy'. The import resolves at PROXY_READY; the master follows as ConformUpdates. */
  stage: 'probe' | 'conform' | 'proxy';
  fraction: number;
}

/** What a raw file is and how the source browser can preview it (engine/src/preview/probe.ts). */
export interface PreviewInfo {
  path: string;
  mode: 'native' | 'filmstrip';
  /** filmstrip only: 'container' (unreadable container), 'codec' (no WebCodecs decoder), 'decoder' (not on this machine). */
  reason?: 'container' | 'codec' | 'decoder';
  container: string;
  codec: string;
  /** Display size, after rotation. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  durationSec: number;
  hdr: boolean;
  hasAudio: boolean;
}

/** A raw-file preview frame. `time` is the frame actually shown: a snap lands on a keyframe. */
export interface PreviewFrameResult {
  image: ImageBitmap;
  time: number;
  exact: boolean;
}

/**
 * Proxy-first import, per source:
 *   PROXY_READY → usable now: browse, slice, mosh preview (frames come back state 'PROXY', ≈)
 *   MASTERING   → the full-quality master is encoding in the background (fraction 0..1)
 *   READY       → the master exists; `conform` is the ready record to store in the project
 *   FAILED      → the master failed; the proxy still works, export and EXACT do not
 * One master encodes at a time, oldest first; an export moves its clips to the front.
 */
export type ConformState = 'PROXY_READY' | 'MASTERING' | 'READY' | 'FAILED';
export interface ConformUpdate {
  sourceId: SourceId;
  state: ConformState;
  /** MASTERING only: the master encode's progress. */
  fraction?: number;
  /** READY: the ready record. Replace the project's proxy-stage record with it (same id). */
  conform?: ConformedSource;
  error?: MoshpitErrorJSON;
}

/**
 * HUD telemetry (visual language §12.8), pushed by the render worker every ~2 s while something
 * changed. A figure this machine cannot report is null, never estimated.
 */
export interface Telemetry {
  gpu: { name: string; load: number; vramUsedMB: number; vramTotalMB: number } | null;
  /** The engine's rolling mean time to render one frame (ms), and frames served so far. */
  frameMs: number | null;
  framesServed: number;
  /** Bytes in the engine's disk cache (conforms, proxies, freezes, filmstrips). */
  cacheBytes: number | null;
}

export interface RenderJob {
  id: string;
  name: string;
  config: ExportConfig;
  /** Project captured when queued. Omitted by legacy callers: pin the current project at render entry. */
  doc?: ProjectDoc;
  /** Absolute output file. The engine refuses an existing file (EXPORT_EXISTS). */
  outPath: string;
}

export interface RenderProgress {
  fraction: number;
  /** Before encoding: the timeline's full-quality masters still conforming (0..1 overall, clips left). */
  conform?: { fraction: number; clips: number };
  /** One log line per notable step: conform, encode, decode check, write. */
  log?: { level: 'info' | 'warn' | 'ok'; text: string };
}

/** One clip in the EDENA library index. */
export interface LibraryClip {
  path: string;
  name: string;
  probe: SourceProbe;
  rating: number;
  tags: string[];
  /** EDENA's pass/fail tag; false carries the reason code. */
  pass: true | { code: string };
  /** Imported into this project already. */
  sourceId?: SourceId;
}

export interface LibraryFolder {
  path: string;
  name: string;
  count: number;
  children: LibraryFolder[];
}

/** D7: one clip's re-conform compared with its pinned record. */
export interface ConformCheck {
  sourceId: SourceId;
  status: 'same' | 'changed' | 'missing';
  /** CONFORM_CHANGED or MEDIA_FILE_MISSING, as JSON. */
  error?: MoshpitErrorJSON;
}

export interface EngineClient {
  /** The node registry (L19). Feeds the library, the radial menu and socket-drag filtering alike. */
  nodeDefs(): Promise<NodeDef[]>;

  /** L24: the project snapshot the engine compiles from. Called after every committed edit. */
  updateProject(doc: ProjectDoc): void;
  /**
   * One param edit (a slider drag tick, a CT knob). `doc` is the project WITH the edit applied:
   * the client keeps it as its latest snapshot, but sends the engine only the edit. The engine patches its live preview engines instead of
   * recompiling when the param is read at render time, and falls back to updateProject when not
   * (an encoded-stream op's params are compiled into the plan). Readiness audit R-1.
   */
  setParam(doc: ProjectDoc, blockId: BlockId, nodeId: NodeId, key: string, value: number | boolean | string): void;

  /** EDENA library. */
  libraryFolders(): Promise<LibraryFolder[]>;
  libraryClips(folderPath: string): Promise<LibraryClip[]>;
  /** Navigation: a folder's subfolders and parent ('' lists the drives). */
  listDir(dir: string): Promise<import('./service/service').DirListing>;
  /** E14: swap the library roots at runtime and rescan; the same roots again is a plain rescan. The worker maps an empty list to ~/Videos. */
  setLibraryRoots(roots: string[]): Promise<LibraryFolder[]>;
  /** Library metadata, kept in the engine's index across rescans. Rating is clamped to 0–5. */
  setRating(path: string, rating: number): Promise<void>;
  setTags(path: string, tags: string[]): Promise<void>;

  /** D7: re-conform every source and compare with its pinned record. Expensive; on demand. */
  verifyConforms(onProgress?: (p: { done: number; total: number }) => void): Task<ConformCheck[]>;

  /** Probe → conform (L29) → keyframe-locked proxy. */
  /**
   * Probe → proxy (resolves here, `conform.status === 'proxy'`) → master in the background.
   * `proxyFirst: false` resolves only once the master is ready. A cached clip resolves ready at once.
   */
  importClip(path: string, onProgress?: (p: ImportProgress) => void, opts?: { quality?: ConformQuality; proxyFirst?: boolean; range?: SourceRange }): Task<{ source: SourceClip; conform: ConformedSource }>;

  /**
   * Raw-file preview for the source browser: no conform, approximate, disposable.
   *   previewInfo   → 'native' (scrub live) or 'filmstrip' (+ reason): ask once per file
   *   previewFrame  → exact: false while the pointer moves (keyframe snap), true when it rests;
   *                   null means a newer request for that file superseded this one: ignore it
   *   filmstrip     → evenly spaced JPEG stills, for filmstrip files and as thumbnails for any
   *   closePreview  → release a file's decoder when the browser moves on
   * Importing (drag to timeline) conforms through importClip as before.
   */
  previewInfo?(path: string): Promise<PreviewInfo>;
  previewFrame?(path: string, timeSec: number, req: { exact?: boolean; playback?: boolean; size: { w: number; h: number } }): Promise<PreviewFrameResult | null>;
  filmstrip?(path: string, opts?: { count?: number; width?: number }): Promise<{ durationSec: number; width: number; cells: { time: number; jpeg: Uint8Array }[] }>;
  closePreview?(path: string): void;
  /**
   * Phase 2.2 / 2.3: free the trial engine(s) once their audition or the effect browser is done
   * ('audition' = the Program's, 'thumb' = the row previews'). The next trial builds a new one.
   */
  releaseTrials?(role: 'audition' | 'thumb'): void;
  /** Phase 0.1b: the worker's queue probe (request waits, event-loop lag). Tests only; skips the queue. */
  queueProbe?(op: 'reset' | 'read'): Promise<unknown>;

  /** Master progress and completion for every proxy-first import, and for pending masters resumed when a project loads. */
  onConformUpdate?(fn: (u: ConformUpdate) => void): () => void;
  /** The current state of every master the engine knows about (after a reload, to redraw badges). */
  conformStates?(): Promise<ConformUpdate[]>;

  /** HUD telemetry pushes (GPU load + VRAM, frame cost, cache size); see Telemetry. */
  onTelemetry?(fn: (t: Telemetry) => void): () => void;

  /** Scene detection → advisory chapters (§1b). Rough boundaries, frame numbers on the conform. */
  detectCuts(sourceId: SourceId, sensitivity: number): Task<Chapter[]>;

  /** `signal`: abort when the frame is no longer wanted; a request still queued is then skipped. */
  /** `playback`: a play-loop tick; the service may render the frames after it in the same pass. */
  frame(target: FrameTarget, size: { w: number; h: number; quality?: 'auto' | 'full'; interactive?: boolean; playback?: boolean; priority?: 'foreground' | 'background' }, signal?: AbortSignal): Promise<FrameResult>;

  /** Per-clip audio (L27) as peak buckets, 0..1, for the Audio Mirror lane. */
  audioPeaks(sourceId: SourceId, buckets: number): Promise<Float32Array>;

  /** L25: bounce a node or block to a cached clip. */
  freeze(target: FreezeTarget, range: [number, number]): Task<FreezeRecord>;

  render(job: RenderJob, onProgress: (p: RenderProgress) => void): Task<void>;

  /** Errors the engine raises on its own (worker crash, decode failure mid-play). */
  onError(fn: (e: MoshpitErrorJSON) => void): () => void;
  /** A replacement render worker is connected and the last project has been resent. */
  onRestart?(fn: () => void): () => void;
}
