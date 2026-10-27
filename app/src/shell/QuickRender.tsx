// Preview selection (Waxy: "run the chain and see the result now"; external review: name the
// intention, not the mechanism). One control, three scopes — the selected Block (default), the
// arrangement's visible Range, or the Full timeline — rendered through the REAL
// export. The last eight captures live in a replayable review shelf, separate from final exports.
import { useEffect, useRef, useState } from 'react';
import { addJob, cancelJob, progressLabel, retryJob, renderStore, useJobs } from '../state/render';
import { forgetPreview, latestCaptureStore, loadPreviewsQuietly, previewsStore, previewSaveErrorStore, previewSelectionStore, previewMediaUrl, quickStore, type SavedPreview } from '../state/previews';
import { activeBlock, getDoc, useProject } from '../state/project';
import { settingsStore } from '../state/ui';
import { readSticky, useSticky, useStore } from '../state/store';
import { frameRangeOf } from '../components/nodes';
import { timelineFrames } from '../lib/timeline';
import { Icon } from '../components/Icon';
import { toast, toastError } from '../qol/qol';
import { host } from '../host';
import { engineKind } from '../engine';

export function previewSize(working: { w: number; h: number }, mode: 'full' | 'fast') {
  const scale = mode === 'fast' ? Math.min(1, 960 / working.w, 540 / working.h) : 1;
  return { w: Math.max(2, Math.round(working.w * scale / 2) * 2), h: Math.max(2, Math.round(working.h * scale / 2) * 2) };
}
export type PreviewScope = 'block' | 'range' | 'full';

let preparing = false;
export async function previewSelection(scope: PreviewScope) {
  if (preparing || renderStore.get().some(j => j.quick && (j.status === 'queued' || j.status === 'rendering'))) return;
  if (engineKind === 'mock') return toast('Open the desktop app to capture playable previews.', { kind: 'info' });
  preparing = true;
  try {
  const d = getDoc();
  const size = previewSize(d.settings.working, readSticky('preview.resolution') === 'fast' ? 'fast' : 'full');
  const total = timelineFrames(d.timeline.blocks);
  if (!total) return toast('Nothing to preview yet: add a block to the arrangement', { kind: 'warn' });
  const b = activeBlock(d);
  let range: [number, number] | undefined;
  let label = 'timeline';
  if (scope === 'block' && b) (range = frameRangeOf(d.timeline.blocks, b)), (label = `Block${d.timeline.blocks.indexOf(b) + 1}`);
  if (scope === 'range') {
    // The arrangement's visible window (its zoom navigator), clamped to the timeline.
    const v = readSticky<{ start: number; len: number; of: number }>('zoom:arrangement');
    const zoomed = v && Number.isFinite(v.start) && Number.isFinite(v.len) && Number.isFinite(v.of) && v.len > 0 && v.of > 0 && v.len < v.of;
    const a = Math.min(total - 1, Math.max(0, Math.floor(zoomed ? v.start : 0)));
    const z = Math.min(total - 1, Math.ceil(zoomed ? v.start + v.len : total - 1));
    range = [a, Math.max(a, z)];
    label = `f${range[0]}-${range[1]}`;
  }
  // Main owns the preview folder (Phase 0.4): the renderer never names a folder to clear.
  const outDir = host.files ? await host.files.previewDir() : `${settingsStore.get().paths.cache.replace(/[\\/]+$/, '')}\\preview`;
  await addJob(`preview_${d.name.replace(/\s+/g, '_')}_${label}_${Date.now().toString(36)}`, { format: 'mp4-h264', width: size.w, height: size.h, range, audio: true, audioMirror: d.exportConfig.audioMirror !== false, outDir }, outDir, { quick: true, doc: d, previewScope: scope === 'block' && b ? `Block ${d.timeline.blocks.indexOf(b) + 1}` : scope === 'range' ? `Range ${label}` : 'Full timeline' });
  } catch (e) { toastError(e); } finally { preparing = false; }
}

const SCOPES: { id: PreviewScope; label: string; hint: string }[] = [
  { id: 'block', label: 'BLOCK', hint: 'The selected block, through its whole chain' },
  { id: 'range', label: 'RANGE', hint: "What the arrangement's zoom shows (fit = the whole timeline)" },
  { id: 'full', label: 'FULL', hint: 'The whole timeline — slow on a long edit' },
];

/**
 * PREVIEW EXTENT (V4, UX round 2): what a temporary preview covers, each option with its one-line
 * meaning shown, and the amber button that renders it (transient: never a committed render).
 */
export function PreviewSelection() {
  const jobs = useJobs();
  const blocks = useProject((d) => d.timeline.blocks.length);
  const [scope, setScope] = useSticky<PreviewScope>('preview.scope', 'block');
  const [resolution, setResolution] = useSticky<'full' | 'fast'>('preview.resolution', 'full');
  const working = useProject(d => d.settings.working);
  const size = previewSize(working, resolution);
  const run = jobs.find((j) => j.quick && (j.status === 'rendering' || j.status === 'queued'));
  return (
    <span className="previewsel">
      <span className="pxlbl">PREVIEW EXTENT</span>
      <span className="seg" role="radiogroup" aria-label="Preview scope">
        {SCOPES.map((s) => (
          <button key={s.id} role="radio" aria-checked={scope === s.id} className={scope === s.id ? 'on' : ''} onClick={() => setScope(s.id)} title={s.hint}>{s.label}</button>
        ))}
      </span>
      <span className="pxhint">{SCOPES.find((s) => s.id === scope)!.hint}</span>
      <span className="seg" role="radiogroup" aria-label="Capture resolution">
        <button role="radio" aria-checked={resolution === 'full'} className={resolution === 'full' ? 'on' : ''} onClick={() => setResolution('full')} title={`Capture at the working resolution: ${working.w}×${working.h}`}>Full</button>
        <button role="radio" aria-checked={resolution === 'fast'} className={resolution === 'fast' ? 'on' : ''} onClick={() => setResolution('fast')} title="Smaller saved preview, fitted within 960×540">Small</button>
      </span>
      <span className="hdnote">{size.w}×{size.h}</span>
      <button className={'quickbtn' + (run ? ' busy' : '')} disabled={!blocks || !!run} onClick={() => void previewSelection(scope)} title={!blocks ? 'Nothing to preview: add a block to the arrangement first' : run ? 'A preview is rendering' : `Capture this version at ${size.w}×${size.h} through the export engine; replay it in Previews & export`}>
        <Icon name="play" size={14} />
        {run ? progressLabel(run) : <>Capture preview</>}
      </button>
      {run && <button className="ghostbtn" onClick={() => cancelJob(run.id)}>Cancel</button>}
    </span>
  );
}

const previewLabel = (p: SavedPreview) => `${new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${p.scope}`;

/** Recall a rendered version without re-rendering or modifying the current project. */
export function RecentPreviews() {
  const projectId = useProject(d => d.id);
  const all = useStore(previewsStore, s => s);
  const selectedId = useStore(previewSelectionStore, s => s);
  const expanded = useStore(quickStore, s => s);
  const saveError = useStore(previewSaveErrorStore, s => s);
  const latestCapture = useStore(latestCaptureStore, s => s);
  const [reference, setReference] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const position = useRef(0);
  const recent = all.filter(p => p.projectId === projectId);
  const selected = recent.find(p => p.id === selectedId) ?? recent[0];
  const ref = recent.find(p => p.id === reference);
  const jobs = useJobs();
  const failedJob = jobs.find(j => j.quick && j.status === 'failed' && j.doc?.id === projectId);
  useEffect(loadPreviewsQuietly, []);
  useEffect(() => { if (expanded) video.current?.pause(); }, [expanded]);
  const select = (id: string) => {
    position.current = video.current?.currentTime ?? 0;
    previewSelectionStore.set(id);
  };
  return <section className="preview-shelf" aria-label="Recent previews">
    <div className="preview-shelf-media">
      {selected ? <video ref={video} key={selected.path} src={previewMediaUrl(selected.path)} controls loop autoPlay={!expanded && selected.id === latestCapture} preload="metadata" aria-label="Saved preview player"
        onLoadedMetadata={e => { e.currentTarget.currentTime = Math.min(position.current, Math.max(0, e.currentTarget.duration - 0.05)); }}
        onError={() => setFailed(selected.id)} /> : <div className="preview-empty">Capture a preview above.<br /><span className="dim">Compare earlier versions here while you edit.</span></div>}
    </div>
    <div className="preview-shelf-tools">
      <label>Recent previews <span className="dim">{recent.length ? `(${recent.length})` : ''}</span>
        <select aria-label="Choose saved preview" value={selected?.id ?? ''} disabled={!recent.length} onChange={e => select(e.target.value)}>
          {!recent.length && <option value="">No previews yet</option>}
          {recent.map((p, i) => <option key={p.id} value={p.id}>{i === 0 ? 'Latest · ' : ''}{previewLabel(p)}</option>)}
        </select>
      </label>
      <div className="preview-actions">
        <button disabled={!selected} onClick={() => { position.current = 0; if (video.current) { video.current.currentTime = 0; void video.current.play().catch(toastError); } }}>Replay</button>
        <button disabled={!selected} onClick={() => selected && quickStore.set(selected)}>Expand</button>
        <button disabled={!selected} title="Keep this version as a reference, then select a newer preview" onClick={() => setReference(selected!.id)}>Set reference</button>
        <button disabled={!ref || !selected || ref.id === selected.id} title="Switch to the reference at the same playback time; press again to switch back" onClick={() => { if (ref && selected) { select(ref.id); setReference(selected.id); } }}>A/B</button>
        <button disabled={!selected} title="Remove from recent previews" onClick={() => selected && void forgetPreview(selected.id).catch(toastError)}>Remove</button>
      </div>
      {ref && <span className="dim">Reference: {previewLabel(ref)}</span>}
      <span className="dim">Last 8 captures across projects · 960×540 · cached between sessions</span>
      {saveError && <span role="alert">{saveError}</span>}
      {selected && failed === selected.id && <span role="alert">Preview file unavailable. Capture again or remove this entry.</span>}
      {failedJob && <div role="alert">Preview failed: {failedJob.error?.humanMessage ?? 'Capture did not finish.'} <button onClick={() => retryJob(failedJob.id)}>Retry</button></div>}
    </div>
  </section>;
}

/** Plays the last preview, looping, until closed (Esc). */
export function QuickPreview() {
  const q = useStore(quickStore, (s) => s);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!q) return;
    const previous = document.activeElement;
    dialog.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && quickStore.set(null);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [q]);
  if (!q) return null;
  return (
    <div ref={dialog} tabIndex={-1} className="quickov" role="dialog" aria-modal="true" aria-label="Preview selection" onClick={() => quickStore.set(null)} onKeyDown={e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); quickStore.set(null); }
      if (e.key === 'Tab') {
        const controls = [...e.currentTarget.querySelectorAll<HTMLElement>('button,video')];
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="quickbox" onClick={(e) => e.stopPropagation()}>
        <div className="quickhd"><b>Saved preview</b><span className="dim">{previewLabel(q)} · 960×540</span><button className="x" onClick={() => quickStore.set(null)} title="Close (Esc)">✕</button></div>
        <video key={q.path} src={previewMediaUrl(q.path)} autoPlay loop controls tabIndex={0} />
      </div>
    </div>
  );
}
