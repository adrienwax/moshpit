// Small, durable review shelf. Metadata is saved before pruning any cache files.
import { host } from '../host';
import { toastError } from '../qol/qol';
import { createStore } from './store';

export const PREVIEW_LIMIT = 8;
export interface SavedPreview {
  id: string;
  path: string;
  label: string;
  projectId: string;
  createdAt: number;
  scope: string;
}
export const previewsStore = createStore<SavedPreview[]>([]);
export const previewSelectionStore = createStore<string | null>(null);
export const latestCaptureStore = createStore<string | null>(null);
export const previewSaveErrorStore = createStore<string | null>(null);
export const quickStore = createStore<SavedPreview | null>(null);
export const previewMediaUrl = (path: string) => `moshpit://app/media/${encodeURIComponent(path)}`;

export function parsePreviews(value: unknown): SavedPreview[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((p): p is SavedPreview => {
    if (!p || typeof p !== 'object' || !['id', 'path', 'label', 'projectId', 'scope'].every(k => typeof p[k] === 'string') || !Number.isFinite(p.createdAt)) return false;
    if (!/[/\\]preview_[^/\\]+\.mp4$/i.test(p.path) || seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  }).sort((a, b) => b.createdAt - a.createdAt).slice(0, PREVIEW_LIMIT);
}

let loading: Promise<void> | undefined;
let writes = Promise.resolve();
export function loadPreviews(): Promise<void> {
  return loading ??= host.readConfig('previews').then(v => { previewsStore.set(parsePreviews([...previewsStore.get(), ...parsePreviews(v)])); }).catch(e => {
    loading = undefined;
    throw e;
  });
}

/** A failed metadata write keeps the file and makes the failure visible; a later write can retry. */
export function rememberPreview(preview: SavedPreview, protectedPaths: string[] = []): Promise<void> {
  const operation = writes.catch(() => {}).then(async () => {
    try { await loadPreviews(); } catch (e) {
      // An unreadable index must not hide a file just rendered or overwrite older disk metadata.
      previewsStore.set(parsePreviews([preview, ...previewsStore.get()]));
      previewSelectionStore.set(preview.id);
      latestCaptureStore.set(preview.id);
      throw e;
    }
    const next = parsePreviews([preview, ...previewsStore.get().filter(p => p.path !== preview.path)]);
    previewsStore.set(next);
    previewSelectionStore.set(preview.id);
    latestCaptureStore.set(preview.id);
    await host.writeConfig('previews', next);
    // Only main's preview cache is touched. Render/queued files and the expanded player survive.
    await host.files?.clearPreviews([...next.map(p => p.path), ...protectedPaths, ...(quickStore.get() ? [quickStore.get()!.path] : [])]);
    previewSaveErrorStore.set(null);
  }).catch(e => {
    previewSaveErrorStore.set('Preview history could not be saved. Keep this session open; the next capture will retry.');
    throw e;
  });
  writes = operation;
  return operation;
}

export function forgetPreview(id: string): Promise<void> {
  const operation = writes.catch(() => {}).then(async () => {
    await loadPreviews();
    const next = previewsStore.get().filter(p => p.id !== id);
    await host.writeConfig('previews', next);
    previewsStore.set(next);
    previewSaveErrorStore.set(null);
    if (quickStore.get()?.id === id) quickStore.set(null);
    // Forget is metadata-only; old cache files are reclaimed after the next successful capture.
  });
  writes = operation;
  return operation;
}

export const loadPreviewsQuietly = () => void loadPreviews().catch(toastError);
