import { useEffect } from 'react';
import type { ExportConfig } from '@moshpit/engine';
import { PRESETS, RESOLUTIONS, resolveExportPreset, exportPresetMatches, exportPresetDescription, ROLE_TEXT, STAGES, queueRender, roleOf, cancelJob, clearDone, formatLabel, progressLabel, retryJob, runAll, stageOf, useRenders, type Job } from '../../state/render';
import { FPS_OPTIONS, changeProjectFormat, getDoc, setExportConfig, useProject } from '../../state/project';
import { host } from '../../host';
import { setUi, useSettings, useUi } from '../../state/ui';
import { fmtFps, timecode } from '../../lib/time';
import { exportAudioSummary } from '../../lib/exportAudio';
import { Empty, confirmAction } from '../../qol/qol';
import { createStore, useSticky, useStore } from '../../state/store';
import { RadialPick } from '../../radial/RadialPick';
import type { PickOption } from '../../radial/Radial';

/** Codec as a 2-level radial: families first (HAP › / ProRes ›), then the variant. */
const CODEC_PICK: PickOption<ExportConfig['format']>[] = [
  { label: 'HAP', color: 'var(--teal)', hint: 'GPU-decoded codecs for VJ playback', children: [
    { label: 'HAP', value: 'hap', color: 'var(--teal)' },
    { label: 'HAP Q', value: 'hapq', color: 'var(--teal)', hint: 'Higher quality, bigger files' },
    { label: 'HAP Alpha', value: 'hap-alpha', color: 'var(--teal)', hint: 'Keeps transparency' },
  ] },
  { label: 'ProRes', color: 'var(--sky)', hint: 'High-quality intermediate codecs for editing and reference exports', children: [
    { label: '422 HQ', value: 'prores-422hq', color: 'var(--sky)' },
    { label: '4444', value: 'prores-4444', color: 'var(--sky)', hint: 'Keeps alpha' },
  ] },
  { label: 'H.264', value: 'mp4-h264', color: 'var(--lav)', hint: 'Compact delivery files for review and the web' },
  { label: 'PNG seq', value: 'png-seq', color: 'var(--gold)', hint: 'One lossless still per frame' },
];
const RES_COLOURS = ['var(--lav)', 'var(--teal)', 'var(--sky)', 'var(--coral)', 'var(--gold)'];

// The export settings live in the project (L13: exportConfig is saved with it); only the file
// name is a session draft.
const draftName = createStore('');
export function applyPreset(i: number) {
  const p = PRESETS[i];
  setExportConfig(resolveExportPreset(p, getDoc().settings.working), `Export preset → ${p.name}`);
}
const resLabel = (w: number, h: number) => RESOLUTIONS.find((r) => r.w === w && r.h === h)?.label ?? `${w}×${h}`;

const STATUS: Record<Job['status'], { cls: string; label: string }> = {
  queued: { cls: 'queue', label: 'queued' },
  rendering: { cls: 'render', label: 'rendering' },
  done: { cls: 'done', label: 'done' },
  failed: { cls: 'fail', label: 'failed' },
  cancelled: { cls: 'fail', label: 'cancelled' },
};

/** The radial holds 6 slices: the five common rates one tap away, the high rates under More. */
const fpsOpt = (f: { num: number; den: number }) => ({ label: fmtFps(f), value: `${f.num}/${f.den}` });
const FPS_PICK: PickOption<string>[] = [
  ...FPS_OPTIONS.filter((f) => f.num / f.den < 31).map(fpsOpt),
  { label: 'More', value: '', children: FPS_OPTIONS.filter((f) => f.num / f.den >= 31).map(fpsOpt) },
];

let lastSavedDir: string | undefined;

export function ExportForm({ compact }: { compact?: boolean }) {
  const doc = useProject(p => p);
  const ec = doc.exportConfig;
  const audioSummary = exportAudioSummary(doc);
  const supportsAudio = ec.format !== 'png-seq';
  const outDefault = useSettings((s) => s.paths.output);
  const project = useProject((p) => p.name);
  const fps = useProject((p) => p.settings.fps);
  const working = useProject(p => p.settings.working);
  const draft = useStore(draftName, (s) => s);
  const savedDir = ec.outDir || outDefault;
  // B7: a half-typed export folder survives a workspace switch; a new saved folder replaces it.
  const [dir, setDir] = useSticky('export.dir', savedDir);
  useEffect(() => {
    if (savedDir !== lastSavedDir) (lastSavedDir = savedDir, setDir(savedDir));
  }, [savedDir, setDir]);
  const mirror = ec.audioMirror !== false;
  const name = draft.trim() || `${project.replace(/\s+/g, '_')}_${ec.format}_${ec.width}x${ec.height}`;
  const commitDir = () => dir !== savedDir && setExportConfig({ outDir: dir }, 'Export folder');
  const queue = () => void queueRender(name, dir);
  return (
    <div className="exprow">
      <div className="fld">
        <label>Codec</label>
        <RadialPick title="Codec" value={ec.format} options={CODEC_PICK} onChange={(format) => setExportConfig({ format }, `Export codec → ${formatLabel(format)}`)} label={formatLabel(ec.format)} />
        <span className={'fmtrole ' + roleOf(ec.format)} title={ROLE_TEXT[roleOf(ec.format)].tip}>{ROLE_TEXT[roleOf(ec.format)].tag}</span>
      </div>
      <div className="fld">
        <label>Resolution</label>
        <RadialPick title="Resolution" value={RESOLUTIONS.findIndex((r) => r.w === ec.width && r.h === ec.height)} options={RESOLUTIONS.map((r, i) => ({ label: r.label.replace(/ \(.*\)/, ''), value: i, color: RES_COLOURS[i % RES_COLOURS.length], hint: r.label }))} onChange={(i) => setExportConfig({ width: RESOLUTIONS[i].w, height: RESOLUTIONS[i].h }, `Export size → ${RESOLUTIONS[i].label}`)} label={resLabel(ec.width, ec.height)} />
      </div>
      {/* F2: the export renders at the project's rate, so this picks the project rate (Settings has the same control). */}
      <div className="fld small" title="Exports render at the project's rational frame rate (L9); changing it here changes the project's rate">
        <label>FPS</label>
        <RadialPick title="Frame rate" value={`${fps.num}/${fps.den}`} options={FPS_PICK} onChange={(v) => { const [num, den] = v.split('/').map(Number); void changeProjectFormat(`Frame rate → ${fmtFps({ num, den })}`, { fps: { num, den } }); }} label={fmtFps(fps)} />
      </div>
      <div className="fld">
        <label>Audio</label>
        <button className={'sel2' + (supportsAudio && ec.audio ? ' on' : '')} aria-label="Export audio" aria-pressed={supportsAudio && ec.audio} disabled={!supportsAudio} onClick={() => setExportConfig({ audio: !ec.audio }, ec.audio ? 'Export without audio' : 'Export with audio track')} title={supportsAudio ? 'On includes an audio track, which may be silent. Off omits it.' : 'PNG sequences contain images only. Your audio choice is kept for video exports.'}>{supportsAudio ? (ec.audio ? '♪ On' : 'Off') : 'Off · PNG'}</button>
      </div>
      {/* The Audio Mirror pane is gone: this switch is the whole audio-glitch control (Waxy). */}
      <div className="fld">
        <label>Glitched audio</label>
        <button className={'sel2' + (supportsAudio && ec.audio && mirror ? ' on' : '')} disabled={!supportsAudio || !ec.audio} onClick={() => setExportConfig({ audioMirror: !mirror }, mirror ? 'Export clean audio' : 'Export glitched audio')} title="Export glitched audio: the clip audio is corrupted over the same ranges as the video effects (gate / crush / filter sends). Off = the clip audio plays clean.">{supportsAudio && ec.audio && mirror ? '◉ glitched' : '○ clean'}</button>
      </div>
      <span className="export-audio-status" role="status" title={audioSummary.detail}>{audioSummary.label}</span>
      {!compact && (
        <div className="fld pathfld">
          <label>Name</label>
          <input className="sel2" placeholder={name} value={draft} onChange={(e) => draftName.set(e.target.value)} />
        </div>
      )}
      <div className="fld pathfld">
        <label>Output folder</label>
        <input className="sel2" value={dir} onChange={(e) => setDir(e.target.value)} onBlur={commitDir} spellCheck={false} />
      </div>
      {!compact && (
        <div className="fld">
          <label>Preset</label>
          <RadialPick title="Export preset" value={-1} options={PRESETS.map((p, i) => ({ label: p.name.replace(/ — .*/, ''), value: i, color: 'var(--gold)', hint: exportPresetDescription(p, working) }))} onChange={applyPreset} label="⊕ From preset" />
        </div>
      )}
      <button className="btn-run" onClick={queue} title="Render now (after any job already running). An existing file is never overwritten: the name gets the next _vNN.">▶ Render {compact ? 'export' : '· add job'}</button>
      {!compact && <p className="rosafe wide">Renders only ever add new files here. Your sources are read-only: Moshpit never changes, moves or deletes them, and refuses an output path that is one of them.</p>}
    </div>
  );
}

/**
 * The render's stages as a stepper, the current one lit, done ones filled. The current stage's bar
 * shows its real fraction, or moving stripes where nothing can be measured (prepare, finalize):
 * never an empty bar that reads as stuck. A measured 0 is shown as stripes too (P2, audit).
 */
export function StageBar({ job }: { job: Job }) {
  const { stage, fraction } = stageOf(job);
  const at = STAGES.findIndex((s) => s.id === stage);
  return (
    <div className="stagebar" role="progressbar" aria-valuetext={progressLabel(job)} aria-valuenow={!fraction ? undefined : Math.round(fraction * 100)}>
      {STAGES.map((s, i) => (
        <div key={s.id} className={'stg' + (i < at ? ' done' : i === at ? ' cur' : '') + (i === at && !fraction ? ' indet' : '')} title={s.label}>
          <i>{s.label}</i>
          <span className="sfill" style={i === at && fraction ? { width: fraction * 100 + '%' } : undefined} />
        </div>
      ))}
    </div>
  );
}

/** Show the written file in the system file browser (desktop only). */
function RevealBtn({ path }: { path: string }) {
  if (!host.files) return null;
  return <button className="ghostbtn reveal" title={`Show ${path} in its folder`} onClick={(e) => (e.stopPropagation(), void host.files!.reveal(path))}>📂</button>;
}

export function PresetsPane() {
  const working = useProject(p => p.settings.working);
  const ec = useProject((p) => p.exportConfig);
  return (
    <div>
      {PRESETS.map((p, i) => (
        <div key={p.name} className={'preset-item' + (exportPresetMatches(p, ec, working) ? ' on' : '')} onClick={() => applyPreset(i)} title="Fill the new-job form with this preset" role="button">
          <div className="pn">{p.name}</div>
          <div className="pd">{exportPresetDescription(p, working)}</div>
        </div>
      ))}
      <div className="footnote" style={{ margin: 0 }}>Project size · proxy keeps the same aspect</div>
    </div>
  );
}

export function QueuePane() {
  const jobs = useRenders();
  const sel = useUi((s) => s.renderJob);
  if (!jobs.length) return <Empty icon="⤓" title="The queue is empty">Choose a preset or settings on the left, then ▶ Render.</Empty>;
  return (
    <table className="rtable">
      <thead>
        <tr><th>Job</th><th>Codec</th><th>Size</th><th style={{ width: 140 }}>Progress</th><th>Status</th><th /></tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} className={j.id === sel ? 'cur' : ''} onClick={() => setUi({ renderJob: j.id })}>
            <td title={j.outPath}>{j.name}</td>
            <td>{formatLabel(j.config.format)}</td>
            <td>{j.config.width}×{j.config.height}</td>
            <td>{j.status === 'rendering' ? <StageBar job={j} /> : <div className="bar"><div className="fill" style={{ width: j.fraction * 100 + '%' }} /></div>}</td>
            <td><span className={'st ' + STATUS[j.status].cls} title={j.error ? `${j.error.humanMessage}${j.error.suggestedFix ? ' — ' + j.error.suggestedFix : ''}` : undefined}>{j.status === 'rendering' ? progressLabel(j) : j.status === 'failed' && j.error ? `failed: ${j.error.humanMessage}` : STATUS[j.status].label}</span></td>
            <td className="rowact">
              {(j.status === 'queued' || j.status === 'rendering') && <button className="ghostbtn" onClick={(e) => (e.stopPropagation(), cancelJob(j.id))} title="Cancel this job">✕</button>}
              {(j.status === 'failed' || j.status === 'cancelled') && <button className="ghostbtn" onClick={(e) => (e.stopPropagation(), retryJob(j.id))} title="Queue again">⟳</button>}
              {j.status === 'done' && <RevealBtn path={j.outPath} />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function QueueTools() {
  const jobs = useRenders();
  return (
    <>
      <button className="ghostbtn" disabled={!jobs.some((j) => j.status === 'queued')} onClick={runAll} title={jobs.some((j) => j.status === 'queued') ? 'Render every queued job, one after another' : 'No queued jobs: add one with Render'}>▶ Run all</button>
      <button
        className="ghostbtn"
        disabled={!jobs.some((j) => j.status === 'done' || j.status === 'cancelled')}
        title={jobs.some((j) => j.status === 'done' || j.status === 'cancelled') ? 'Remove done and cancelled jobs from the list (files stay on disk)' : 'No finished jobs to clear'}
        onClick={async () => (await confirmAction('Clear finished jobs?', 'Removes done and cancelled jobs from the list. Rendered files on disk are not touched.', 'Clear')) && clearDone()}
      >
        clear done
      </button>
    </>
  );
}

export function LogPane() {
  const jobs = useRenders();
  const sel = useUi((s) => s.renderJob);
  const fps = useProject((d) => d.settings.fps);
  const j = jobs.find((x) => x.id === sel) ?? jobs[jobs.length - 1];
  if (!j) return <Empty icon="▤" title="No output yet">The converter's log for the selected job shows here.</Empty>;
  return (
    <div style={{ padding: 10 }}>
      <div className="logbox" role="log">
        <div className="dim">[{j.status}] {j.outPath}</div>
        {j.config.range && <div className="dim">range {timecode(j.config.range[0], fps)}–{timecode(j.config.range[1], fps)}</div>}
        {j.log.map((l, i) => <div key={i} className={l.level === 'ok' ? 'ok' : l.level === 'warn' ? 'warn' : ''}>{l.text}</div>)}
        {j.status === 'rendering' && <div className="warn">… {progressLabel(j)}</div>}
      </div>
    </div>
  );
}
