// A project, compiled for execution: opens each source's conformed master (and proxy), compiles
// every block's graph (stage 2), then the timeline (stage 1) in the variants the engine needs.
// The render worker and the harness both go through here, so there is one way to get from a
// project document to pixels.

import { MoshpitError } from '../errors';
import type { BlockId, ConformedSource, NodeId, ProjectDoc, SourceId } from '../model';
import { demux, openSamples } from '../bitstream/mp4';
import { compileStage1, type ClipInput, type EncodedOp, type Stage1Plan } from '../timeline/stage1';
import { compileBlockGraph, type BlockPlan } from '../graph/stage2';
import type { EngineOptions } from './engine';

export interface CompiledProject {
  plan: Stage1Plan;
  /** Present when compiled for the GPU proxy: `plan` is then the clean stream. */
  moshed?: Stage1Plan;
  blockPlans: Map<BlockId, BlockPlan>;
  close(): void;
}

export interface CompileProjectOptions {
  variant?: 'master' | 'proxy';
  backend?: 'preview' | 'export';
  /** D1/L18: preview mosh via the GPU proxy over a clean decode instead of decoding the moshed stream. */
  gpuProxy?: boolean;
  /** §1e per-node viewer: compile this block to end at this node instead of its Output. */
  viewer?: { blockId: BlockId; nodeId: NodeId };
}

export function conformFor(doc: ProjectDoc, sourceId: SourceId): ConformedSource {
  const src = doc.resources.sources.find((s) => s.id === sourceId);
  if (!src) throw new MoshpitError('MEDIA_FILE_MISSING', { sourceId });
  const c = doc.resources.conforms.find((x) => x.id === src.conformId) ?? doc.resources.conforms.find((x) => x.sourceId === sourceId);
  if (!c) throw new MoshpitError('CONFORM_FAILED', { sourceId, why: 'no conform recorded' });
  return c;
}

export function compileProject(doc: ProjectDoc, o: CompileProjectOptions = {}): CompiledProject {
  const variant = o.variant ?? 'master';
  const clips = new Map<SourceId, ClipInput>();
  const close = () => { for (const c of clips.values()) c.reader.close(); };
  try {
    for (const b of doc.timeline.blocks) {
      if (clips.has(b.sourceId)) continue;
      const record = conformFor(doc, b.sourceId);
      const file = variant === 'proxy' ? record.proxy?.path : record.path;
      if (!file) throw new MoshpitError('CONFORM_FAILED', { sourceId: b.sourceId, why: 'no proxy conform' });
      const video = demux(file);
      clips.set(b.sourceId, { record, video, reader: openSamples(video) });
    }
    const blockPlans = new Map<BlockId, BlockPlan>();
    const encodedOps = new Map<BlockId, EncodedOp[]>();
    for (const b of doc.timeline.blocks) {
      const p = compileBlockGraph(b.id, b.graph, { backend: o.backend ?? 'export', terminal: o.viewer?.blockId === b.id ? o.viewer.nodeId : undefined });
      blockPlans.set(b.id, p);
      encodedOps.set(b.id, p.encodedOps);
    }
    const base = { blocks: doc.timeline.blocks, clips, fps: doc.settings.fps, encodedOps, variant };
    const moshed = compileStage1(base);
    if (o.gpuProxy) return { plan: compileStage1({ ...base, clean: true }), moshed, blockPlans, close };
    return { plan: moshed, blockPlans, close };
  } catch (e) { close(); throw e; }
}

export function engineOptions(doc: ProjectDoc, c: CompiledProject, extra: Omit<EngineOptions, 'plan' | 'moshed' | 'blocks' | 'blockPlans' | 'lfos' | 'bpm' | 'seed'>): EngineOptions {
  return { plan: c.plan, moshed: c.moshed, blocks: doc.timeline.blocks, blockPlans: c.blockPlans, lfos: doc.modulators.lfos, values: doc.modulators.values ?? [], bpm: doc.settings.bpm, seed: doc.settings.seed, ...extra };
}
