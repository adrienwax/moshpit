// MOSH scopes measure stopped frames only; IN and MOSH share plots and pixel math.
import { useEffect, useMemo, useState } from 'react';
import type { FrameTarget, ProjectDoc } from '@moshpit/engine';
import { engine } from '../engine';
import { asError } from '../qol/qol';
import { useUi } from '../state/ui';
import { activeBlock, useProject } from '../state/project';
import { blockAt, blockFrames, blockStarts, timelineFrames } from '../lib/timeline';
import { useSticky, useStickyValue } from '../state/store';
import { accumulateScope, newScopeData, scopeRange, type ScopeData } from '../scopes/data';
import { ScopePanel, type ScopeStatus } from '../scopes/ScopePanel';
export { analyse, type ScopeData } from '../scopes/data';

export type ScopeTarget = 'full' | 'block' | 'node' | 'range';
export type ScopeSize = 'S' | 'M' | 'L';
const TARGETS = [
  { id: 'full', label: 'Program', hint: 'Final output at the stopped playhead' },
  { id: 'block', label: 'Block input', hint: 'The block input before its effects' },
  { id: 'node', label: 'Selected node', hint: 'The signal at the selected node' },
  { id: 'range', label: 'Visible range', hint: 'Pooled pixel density from up to 8 frames in the visible arrangement range' },
] as const;
const W = 320, H = 180;

type ScopeZoom = { start: number; len: number; of: number };
export function scopeTargets(doc: ProjectDoc, target: ScopeTarget, playhead: number, zoom?: ScopeZoom): FrameTarget[] {
  const blocks = doc.timeline.blocks, total = timelineFrames(blocks);
  if (!blocks.length || total < 1) return [];
  const frame = Math.max(0, Math.min(total - 1, Number.isFinite(playhead) ? Math.floor(playhead) : 0));
  if (target === 'range') {
    const [a, z] = scopeRange(total, zoom)!;
    return [...new Set(Array.from({ length: 8 }, (_, i) => Math.round(a + (z - a) * (i + 0.5) / 8)))].map(frame => ({ kind: 'output', frame }));
  }
  if (target === 'block') {
    const at = blockAt(blocks, frame);
    if (!at) return [];
    const b = at.block;
    return [{ kind: 'source', sourceId: b.sourceId, frame: b.in + at.local % Math.max(1, b.out - b.in) }];
  }
  if (target === 'node') {
    const b = activeBlock(doc), selected = b && doc.view.perBlock[b.id]?.selected?.[0];
    if (!b || !selected) return [];
    const start = blockStarts(blocks)[blocks.indexOf(b)];
    return [{ kind: 'node', blockId: b.id, nodeId: selected, frame: Math.max(start, Math.min(start + blockFrames(b) - 1, frame)) }];
  }
  return [{ kind: 'output', frame }];
}

interface Measurement { targets: FrameTarget[]; target: ScopeTarget; epoch: number; data: ScopeData | null; detail: string; error?: boolean }

export function ScopesInline() {
  // Mask the moving playhead so scopes issue no additional requests each playback tick.
  const playhead = useUi(s => s.playing ? -1 : s.playhead), playing = useUi(s => s.playing);
  const doc = useProject(d => d);
  const [target, setTarget] = useSticky<ScopeTarget>('scope.target', 'full');
  const arrangementZoom = useStickyValue<ScopeZoom>('zoom:arrangement');
  const zoom = target === 'range' ? arrangementZoom : undefined;
  // View-only edits (selection, graph pan/zoom) do not change Program pixels. Selected-node
  // scopes still follow selection through the derived targets. A range ignores playhead moves
  // until its actual sampled frames change. Keep pixel edits and project switches observable.
  const requested = scopeTargets(doc, target, playhead, zoom);
  const targetKey = JSON.stringify(requested);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const targets = useMemo(() => requested, [targetKey, doc.id, doc.timeline, doc.resources, doc.settings, doc.modulators, doc.freezes, doc.components]);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => engine.onRestart?.(() => setEpoch(n => n + 1)), []);
  useEffect(() => {
    if (playing) return;
    let live = true;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      const save = (data: ScopeData | null, detail: string, error = false) => {
        if (live) setMeasurement({ targets, target, epoch, data, detail, error });
      };
      if (!targets.length) { save(null, target === 'node' ? 'Select a node to measure its output' : 'No frame at this target'); return; }
      try {
        const data = newScopeData(), canvas = new OffscreenCanvas(W, H);
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        let proxy = false;
        for (const ft of targets) {
          const result = await engine.frame(ft, { w: W, h: H, priority: 'background' }, abort.signal);
          try {
            if (!live) return;
            proxy ||= result.state !== 'EXACT';
            ctx.clearRect(0, 0, W, H);
            ctx.drawImage(result.image, 0, 0, W, H);
            accumulateScope(data, ctx.getImageData(0, 0, W, H));
          } finally { result.image.close(); }
        }
        const frames = targets.map(t => t.frame);
        const at = target === 'range' ? `${data.frames} sampled frames · f${Math.min(...frames)}–${Math.max(...frames)} pooled` : `Measured f${frames[0]}`;
        save(data, `${at} · ${proxy ? 'proxy ≈' : 'exact'} · ${W}×${H} sample · display RGB`);
      } catch (error) {
        save(null, asError(error).humanMessage, true);
      }
    }, 60);
    return () => { live = false; abort.abort(); clearTimeout(timer); };
  }, [targets, target, playing, epoch]);
  const current = measurement?.epoch === epoch && measurement.target === target && (playing || measurement.targets === targets) ? measurement : null;
  const status: ScopeStatus = playing ? 'paused' : current?.error ? 'error' : current?.data ? 'measured' : current || !doc.timeline.blocks.length ? 'waiting' : 'measuring';
  const choice = TARGETS.find(t => t.id === target) ?? TARGETS[0];
  return <ScopePanel presentation="strip" data={current?.data ?? null} sourceLabel={`MOSH · ${choice.label}`} status={status}
    detail={current?.detail ?? (!doc.timeline.blocks.length ? 'Add a block to measure the program' : playing ? 'Stop playback to measure the current frame' : 'Sampling the stopped frame · display RGB')}
    controls={<label>Target<select aria-label="Scope target" title={choice.hint} value={target} onChange={e => setTarget(e.target.value as ScopeTarget)}>{TARGETS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>} />;
}
