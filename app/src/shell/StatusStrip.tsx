// The status strip: one line under the top bar — what this workspace is for and the next step,
// the background jobs, and the system gauges (GPU, VRAM, frame, cache, drops, CT). Transport,
// BPM, block and freeze moved to their owners (restructure v2).
import { useProject, mastersPending } from '../state/project';
import { masterStore } from '../state/conforms';
import { useStore } from '../state/store';
import { useUi, type WsId } from '../state/ui';
import { progressLabel, shownFraction, stageOf, useJobs } from '../state/render';
import { useRunningJobs } from '../state/jobs';
import { resetDropped, useHud } from '../state/telemetry';
import { setWs } from '../state/ui';
import { Icon } from '../components/Icon';
import { useControlHostLabel } from '../state/controlStatus';

/** What each workspace is for, and the next step (item 13: Waxy kept getting lost). */
const PURPOSE: Record<WsId, string> = {
  home: 'Start here — open a project, or begin at ① IN.',
  browse: 'Step 1 of 3 — pick a clip, mark IN / OUT, then Send it to slot A or B (or add it as a block).',
  mosh: 'Step 2 of 3 — slice the A/B slots into blocks, give each block effects, Preview selection to check.',
  node: 'Composition graph — all clips and joins. Open a chain for wiring. Alt+G returns to MOSH.',
  render: 'Step 3 of 3 — choose a preset, Render, then check the written file.',
  settings: 'Settings — interaction, media, appearance and project format.',
};

function NextStep({ ws }: { ws: WsId }) {
  const clips = useProject((d) => d.resources.sources.length);
  const blocks = useProject((d) => d.timeline.blocks.length);
  const next: { to: WsId; label: string; ok: boolean; why: string } | null =
    ws === 'home' ? { to: 'browse', label: 'In', ok: true, why: '' }
    : ws === 'browse' ? { to: 'mosh', label: 'Mosh', ok: clips > 0, why: 'Send a selection to A or B first' }
    : ws === 'mosh' || ws === 'node' ? { to: 'render', label: 'Out', ok: blocks > 0, why: 'Add a block to the arrangement first' }
    : null;
  if (!next) return null;
  return (
    <button className="nextbtn" disabled={!next.ok} onClick={() => setWs(next.to)} title={next.ok ? `Go to ${next.label}` : next.why}>
      Next: {next.label} →{!next.ok && <i>{next.why}</i>}
    </button>
  );
}

export function StatusStrip() {
  const ws = useUi((s) => s.ws);
  const jobs = useJobs();
  const running = jobs.find((j) => j.status === 'rendering');
  const queued = jobs.filter((j) => j.status === 'queued').length;
  // Background jobs (imports, scene detection): visible from every workspace.
  const bg = Object.values(useRunningJobs()).filter((j) => j.task);
  // Proxy-first: clips usable on their proxy while full-quality masters encode in the background.
  const pending = useProject((d) => mastersPending(d).length);
  const masterPct = useStore(masterStore, (m) => {
    const f = Object.values(m).find((x) => x.state === 'MASTERING')?.fraction;
    return f == null ? -1 : Math.round(f * 100);
  });

  const job = bg[0];
  // Keep the status row's geometry stable as workspace and background jobs change.
  // Workflow fields moved to their owners (transport, inspector, block badges); this strip keeps
  // where you are, background jobs and the system gauges (Waxy kept those).
  return (
    <div className="statusstrip hud" role="status" aria-label="Status">
      <span className="purpose" title={PURPOSE[ws]}>{ws === 'browse' ? 'Source browser' : ws === 'mosh' ? 'Edit timeline' : ws === 'render' ? 'Export video' : ws === 'node' ? 'Composition graph' : PURPOSE[ws]}</span><NextStep ws={ws} />
      {job && (
        <button className="ro ic job" onClick={() => setWs('browse')} title={`${bg.map((j) => `${j.label}${j.stage ? ` (${j.stage})` : ''} ${Math.round(j.fraction * 100)}%`).join(' · ')}. Running in the background: it keeps going whatever you open. Click for Source.`}>
          <Icon name={job.kind === 'import' ? 'import' : 'slice'} />
          <i className="lbl">{job.kind === 'import' ? 'IMPORT' : 'DETECT'}{bg.length > 1 ? ` +${bg.length - 1}` : ''}</i>
          <b className="val">{Math.round(job.fraction * 100)}%<i className="eta">{eta(job.key, job.fraction)}</i></b>
          <Gauge f={job.fraction} />
        </button>
      )}
      {pending > 0 && (
        <span className="ro ic warn" title="Clips usable now on their proxy; their full-quality masters are encoding in the background, one at a time. Exact preview, freeze and export wait for them.">
          <Icon name="proxy" />
          <i className="lbl">FINALIZING {pending}</i>
          <b className="val">{masterPct >= 0 ? `${masterPct}%` : '…'}</b>
          {masterPct >= 0 && <Gauge f={masterPct / 100} />}
        </span>
      )}
      <span className={'ro ic' + (running ? ' live' : '')} title="Render queue (Alt+3)">
        <Icon name="render" />
        <i className="lbl">RENDER</i>
        <b className="val">{running ? progressLabel(running) : queued ? `${queued} queued` : 'idle'}{running && stageOf(running).stage === 'encode' && <i className="eta">{eta(running.id, running.fraction)}</i>}</b>
        {running && <Gauge f={shownFraction(running)} />}
      </span>
      <span className="spacer" />
    </div>
  );
}

/** The same instruments can sit beside scopes without duplicating telemetry subscriptions. */
export function SystemInstruments() {
  const ct = useControlHostLabel();
  return <div className="system-instruments statusstrip hud" aria-label="System instruments">
      <SystemReadouts />
      <span className={'ct-indicator' + (ct.ready ? ' ok' : '')} aria-label={ct.detail} title={ct.detail}>
        <Icon name="ct-link" />
      </span>
  </div>;
}

// Waxy's micro-pass: compact numbers. No space before the unit, no trailing .0 ("2.2/12GB", "10MB",
// "104ms"); a decimal only where it says something.
const trim = (v: number, d = 1) => String(+v.toFixed(d));
const gb = (mb: number) => trim(mb / 1024);
const size = (b: number) => (b >= 1 << 30 ? `${trim(b / (1 << 30))}GB` : `${Math.round(b / (1 << 20))}MB`);
const ms = (v: number) => `${v < 10 ? trim(v) : Math.round(v)}ms`;

/** GPU load + VRAM, frame cost, cache size, dropped frames (§12.8): measured, or n/a. */
function SystemReadouts() {
  const fps = useProject((d) => d.settings.fps);
  const fpsValue = fps.num / fps.den;
  const t = useHud((s) => s.t);
  const dropped = useHud((s) => s.dropped);
  const g = t?.gpu;
  const budget = 1000 / Math.max(1, fpsValue);
  const load = g && Number.isFinite(g.load) ? Math.max(0, Math.min(1, g.load)) : null;
  const vram = g && Number.isFinite(g.vramUsedMB) && g.vramUsedMB >= 0 && Number.isFinite(g.vramTotalMB) && g.vramTotalMB > 0
    ? g.vramUsedMB / g.vramTotalMB : null;
  return (
    <>
      <span className={'ro sys gpu-meter' + (load != null && load > 0.9 ? ' warn' : '')} title={g ? `${g.name}: whole-machine GPU utilisation from the driver (nvidia-smi), sampled every 2 s` : 'GPU load: this machine reports none (needs an NVIDIA driver with nvidia-smi)'}>
        <RadialGauge f={load} warn={load != null && load > 0.9} />
        <span className="meter-caption"><i className="lbl">GPU</i><b className="val">{load != null ? `${Math.round(load * 100)}%` : 'n/a'}</b></span>
      </span>
      <span className={'ro sys memory-meter' + (vram != null && vram > 0.9 ? ' warn' : '')} title={g ? `Video memory in use on ${g.name} (whole machine, not only Moshpit)` : 'VRAM: not reported on this machine'}>
        <span className="meter-caption"><i className="lbl">VRAM</i><b className="val">{g && vram != null ? `${gb(g.vramUsedMB)}/${gb(g.vramTotalMB)}GB` : 'n/a'}</b></span>
        <span className={'memory-track' + (vram == null ? ' unavailable' : '')} aria-hidden><span style={{ width: `${vram == null ? 0 : Math.min(1, vram) * 100}%` }} /></span>
      </span>
      <span className={'ro sys' + (t?.frameMs != null && t.frameMs > budget ? ' warn' : '')} title={`The engine's mean time to render one frame (last 30). The budget at this frame rate is ${budget.toFixed(1)} ms.${t ? ` ${t.framesServed} frames served.` : ''}`}>
        <i className="lbl">FRAME</i>
        <b className="val">{t?.frameMs != null ? ms(t.frameMs) : '—'}</b>
      </span>
      <span className="ro ic sys" title="The engine's disk cache: conforms, proxies, freezes and filmstrips (disposable)">
        <Icon name="cache" />
        <i className="lbl">CACHE</i>
        <b className="val">{t?.cacheBytes != null ? size(t.cacheBytes) : '—'}</b>
      </span>
      <button className={'ro sys' + (dropped ? ' warn' : '')} onClick={resetDropped} title="Output frames the playhead passed before they could be shown, since the last reset. Click to reset.">
        <i className="lbl">DROP</i>
        <b className="val">{dropped}</b>
      </button>
    </>
  );
}

/** A readable utilization arc; an unavailable sample shows only the neutral track. */
function RadialGauge({ f, warn }: { f: number | null; warn?: boolean }) {
  const r = 11, c = 2 * Math.PI * r, v = f == null ? 0 : Math.max(0, Math.min(1, f));
  return (
    <svg className="rgauge" viewBox="0 0 30 30" width="30" height="30" aria-hidden>
      <circle cx="15" cy="15" r={r} fill="none" stroke="var(--line-2)" strokeWidth="2.5" />
      <circle cx="15" cy="15" r={r} fill="none" stroke={warn ? 'var(--fn-warn)' : 'var(--fn-interactive)'} strokeWidth="2.5" strokeDasharray={`${c * v} ${c}`} transform="rotate(-90 15 15)" strokeLinecap="butt" />
    </svg>
  );
}

/** A linear determinate gauge (§12.3): a 1px rail, a 2px fill that turns ok when done. */
function Gauge({ f }: { f: number }) {
  return <span className="gauge"><span className={'fill' + (f >= 1 ? ' done' : '')} style={{ width: `${Math.max(0, Math.min(1, f)) * 100}%` }} /></span>;
}

// ETA from the progress so far: first seen → now, scaled by what is left.
const started = new Map<string, number>();
function eta(key: string, f: number): string {
  const now = Date.now();
  if (!started.has(key)) started.set(key, now);
  if (f < 0.03) return 'ETA —';
  const left = ((now - started.get(key)!) * (1 - f)) / f / 1000;
  return left >= 60 ? `ETA ${Math.floor(left / 60)}m${String(Math.round(left % 60)).padStart(2, '0')}` : `ETA ${Math.max(1, Math.round(left))}s`;
}
