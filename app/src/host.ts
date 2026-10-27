import type { MoshpitErrorJSON, ProjectDoc } from '@moshpit/engine';

// User/app config on disk (L13). In Electron this is the preload bridge; in a plain browser
// (vite dev without Electron) it falls back to localStorage so the UI still runs.
export interface HostBridge {
  testClipsDir?: string;
  /** Desktop only: a dropped File's path on disk (webUtils.getPathForFile); '' when it has none. */
  pathOf?(file: File): string;
  readConfig(name: 'layouts' | 'settings' | 'previews'): Promise<unknown | null>;
  writeConfig(name: 'layouts' | 'settings' | 'previews', data: unknown): Promise<string>;
  /** Desktop only: the project lifecycle (electron/project-host.ts). */
  project?: ProjectBridge;
  /** Desktop only: native file pickers, bounded reads and atomic saved-look writes. */
  looks?: {
    import(): Promise<IpcResult<string | null>>;
    export(text: string): Promise<IpcResult<string | null>>;
  };
  /** Desktop only: export folders and files. */
  files?: {
    ensureDir(dir: string): Promise<void>;
    /** `path` if free (and not in `taken`), else the first free `name_vNN.ext`. */
    nextFree(path: string, taken: string[]): Promise<string>;
    reveal(path: string): Promise<void>;
    /** The preview cache folder, fixed by main. */
    previewDir(): Promise<string>;
    /** Prunes preview_*.mp4 in that folder only, preserving these absolute paths. */
    clearPreviews(keep?: string[]): Promise<number>;
    /** Native folder picker; null when cancelled. */
    pickFolder(title: string, start?: string): Promise<string | null>;
  };
}

/** Results cross IPC as {ok, value} | {ok: false, error: MoshpitErrorJSON}. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface LoadedProject {
  doc: ProjectDoc;
  warnings: MoshpitErrorJSON[];
  migrated: Record<string, [number, number]>;
  /** The saved file plus the crashed session's journal replayed onto it. */
  recovery?: { doc: ProjectDoc; replayed: number; tornTail: boolean };
}

/** project:peek — what HOME shows on a project card; `error` when the file could not be read. */
export type ProjectPeek =
  | { file: string; error: string }
  | { file: string; error?: undefined; name: string; mtimeMs: number; bytes: number; blocks: number; clips: number; missing: number; seconds: number; bpm: number; fps: number; thumb: { path: string; timeSec: number } | null };

export interface PendingRecovery {
  /** null = an untitled session. */
  file: string | null;
  name: string;
  doc: ProjectDoc;
  replayed: number;
  tornTail: boolean;
}

export interface ProjectBridge {
  openDialog(): Promise<string | null>;
  saveDialog(suggested: string): Promise<string | null>;
  load(file: string): Promise<IpcResult<LoadedProject>>;
  save(file: string, doc: ProjectDoc): Promise<IpcResult<string>>;
  session(file: string | null, saved: ProjectDoc, current: ProjectDoc | null): Promise<IpcResult<string>>;
  journal(doc: ProjectDoc): void;
  pendingRecovery(): Promise<IpcResult<PendingRecovery[]>>;
  discardRecovery(file: string | null): Promise<boolean>;
  /** Why the UI renderer last died, once (null when it did not): the recovery dialog says so. */
  lastCrash?(): Promise<string | null>;
  recents(): Promise<string[]>;
  /** HOME: a read-only summary of a project file (no recents/journal side effects). */
  peek(file: string): Promise<ProjectPeek>;
  onCloseRequested(fn: () => void): void;
  /** Announce after the close listener and startup recovery/session are ready. */
  readyForClose?(): void;
  /** Explicit launcher requests use the same unsaved/recovery checks as File Open. */
  onOpenRequested?(fn: (file: string) => void): () => void;
  readyForOpen?(): void;
  closeNow(discardJournal: boolean): Promise<void>;
}

declare global {
  interface Window {
    moshpitHost?: HostBridge;
  }
}

const browserFallback: HostBridge = {
  async readConfig(name) {
    try {
      const raw = localStorage.getItem('moshpit.config.' + name);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async writeConfig(name, data) {
    // Storage failures must reach the caller: a preset cannot be reported saved if storage is full.
    localStorage.setItem('moshpit.config.' + name, JSON.stringify(data));
    return 'localStorage';
  },
};

const bridge = typeof window === 'undefined' ? undefined : window.moshpitHost;
export const host: HostBridge = bridge ?? browserFallback;
export const onDisk = !!bridge;
