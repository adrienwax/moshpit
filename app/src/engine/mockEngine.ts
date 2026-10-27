// Mock engine: meets EngineClient with deterministic, CSS-palette canvas art (no imagery).
// Frames really change with frame number and with the node chain, so scrubbing, the per-node
// viewer and the scopes all exercise real code paths. Swap for the engine lane's client in
// engine/index.ts; nothing else imports this file.
import type { BlockGraph, NodeDef, NodeId, ProjectDoc, SourceId } from '@moshpit/engine';
import { CONFORM_VERSION, MoshpitError, validRange } from '@moshpit/engine';
import { CATALOG } from './catalog';
import { FOLDERS, LIBRARY } from './mockProject';
import type { EngineClient, FrameResult, FrameTarget, Task } from './EngineClient';
import { blockAt } from '../lib/timeline';

const PALETTE = ['#e8785a', '#4fb8a8', '#d9a441', '#9b7ede', '#6fa8dc', '#d98fa8', '#8fd9a8'];
const BASES = [['#3a2230', '#15202e'], ['#123036', '#1b2630'], ['#2e2a18', '#1c2224'], ['#2a2233', '#1a2330']];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      rej(new DOMException('cancelled', 'AbortError'));
    });
  });

function task<T>(run: (signal: AbortSignal) => Promise<T>): Task<T> {
  const ac = new AbortController();
  return { promise: run(ac.signal), cancel: () => ac.abort() };
}

function paintSource(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, key: string, frame: number) {
  const s = hash(key);
  const [b0, b1] = BASES[s % BASES.length];
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, b0);
  g.addColorStop(1, b1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 3; i++) {
    const c = PALETTE[(s >>> (i * 3)) % PALETTE.length];
    const t = frame * 0.035 + i * 2.1 + (s % 100);
    const x = w * (0.5 + 0.38 * Math.sin(t * (0.7 + i * 0.2)));
    const y = h * (0.5 + 0.34 * Math.cos(t * (0.5 + i * 0.3)));
    const r = ctx.createRadialGradient(x, y, 0, x, y, w * (0.45 + 0.1 * i));
    r.addColorStop(0, c + 'cc');
    r.addColorStop(1, c + '00');
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, w, h);
  }
}

/** One cheap, recognisable treatment per category/family, so each node's viewer looks different. */
function applyNode(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, def: NodeDef, frame: number) {
  const fam = def.family;
  if (def.category === 'Mosh') {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    for (let x = -h; x < w; x += 40) {
      ctx.fillStyle = PALETTE[(x / 40 + frame) & 3] + '66';
      ctx.beginPath();
      ctx.moveTo(x + (frame % 40), 0);
      ctx.lineTo(x + 14 + (frame % 40), 0);
      ctx.lineTo(x + 14 + h * 0.47 + (frame % 40), h);
      ctx.lineTo(x + h * 0.47 + (frame % 40), h);
      ctx.fill();
    }
    ctx.restore();
    // block smear: copy macroblock rows sideways
    for (let y = 0; y < h; y += 16) if ((y / 16 + frame) % 5 === 0) ctx.drawImage(ctx.canvas, 0, y, w, 16, 10 + (frame % 9), y, w, 16);
  } else if (fam === 'Plane') {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.5;
    ctx.drawImage(ctx.canvas, 8, -3);
    ctx.restore();
  } else if (fam === 'Feedback') {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.filter = 'blur(3px)';
    ctx.drawImage(ctx.canvas, -6, 0, w + 12, h);
    ctx.restore();
  } else if (fam === 'Geometry') {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(ctx.canvas, 0, 0, w / 2, h, 0, 0, w / 2, h);
    ctx.restore();
  } else if (fam === 'Tone' || fam === 'Degrade') {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const q = fam === 'Tone' ? 48 : 80;
    for (let i = 0; i < d.length; i += 4) {
      const px = (i >> 2) % w;
      const py = (i >> 2) / w;
      const dith = ((px & 3) * 4 + (py & 3)) * 2;
      d[i] = Math.round((d[i] + dith) / q) * q;
      d[i + 1] = Math.round((d[i + 1] + dith) / q) * q;
      d[i + 2] = Math.round((d[i + 2] + dith) / q) * q;
    }
    ctx.putImageData(img, 0, 0);
  }
}

/** The node chain feeding `target` in graph order (sources first). */
function upstream(graph: BlockGraph, target: NodeId): NodeId[] {
  const seen = new Set<NodeId>();
  const order: NodeId[] = [];
  const visit = (n: NodeId) => {
    if (seen.has(n)) return;
    seen.add(n);
    graph.edges.filter((e) => e.to.node === n).forEach((e) => visit(e.from.node));
    order.push(n);
  };
  visit(target);
  return order;
}

export function createMockEngine(): EngineClient {
  let doc: ProjectDoc | null = null;
  const defs = new Map(CATALOG.map((d) => [d.kind as string, d]));
  const errorListeners = new Set<(e: ReturnType<MoshpitError['toJSON']>) => void>();

  async function frame(target: FrameTarget, size: { w: number; h: number }): Promise<FrameResult> {
    const w = Math.max(16, Math.round(size.w));
    const h = Math.max(9, Math.round(size.h));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    let state: FrameResult['state'] = 'EXACT';
    let route = 'I-frame · exact';

    if (target.kind === 'source') {
      paintSource(ctx, w, h, target.sourceId, target.frame);
      route = target.frame % 12 === 0 ? 'I-frame · exact' : 'P-frame · decoded';
    } else {
      if (!doc) throw new MoshpitError('TIMELINE_EMPTY');
      // Phase 2.2: a trial is the output with one block's graph swapped, drawn from a copy.
      const docNow = doc;
      const view = target.kind === 'trial' ? { ...docNow, timeline: { ...docNow.timeline, blocks: docNow.timeline.blocks.map((b) => (b.id === target.blockId ? { ...b, graph: target.graph } : b)) } } : docNow;
      let blockId = target.kind === 'node' ? target.blockId : undefined;
      // Both targets carry a timeline frame (EngineClient contract).
      const at = blockAt(view.timeline.blocks, target.frame);
      if (target.kind === 'output' || target.kind === 'trial') {
        if (!at) throw new MoshpitError('TIMELINE_EMPTY');
        blockId = at.block.id;
      }
      const local = at && at.block.id === blockId ? at.local : 0;
      const block = view.timeline.blocks.find((b) => b.id === blockId);
      if (!block) throw new MoshpitError('PARAM_UNKNOWN', { blockId });
      const nodeId = target.kind === 'node' ? target.nodeId : block.graph.nodes.find((n) => n.kind === 'output.sink')?.id;
      if (!nodeId) throw new MoshpitError('GRAPH_NO_OUTPUT', { blockId });
      const srcFrame = block.in + (local % Math.max(1, block.out - block.in));
      for (const nid of upstream(block.graph, nodeId)) {
        const inst = block.graph.nodes.find((n) => n.id === nid);
        const def = inst && defs.get(inst.kind);
        if (!inst || !def) continue;
        if (def.category === 'Source') paintSource(ctx, w, h, block.sourceId, srcFrame);
        else if (!inst.bypass) applyNode(ctx, w, h, def, srcFrame);
        if (def.impl.preview === 'PROXY') state = 'PROXY';
      }
      route = state === 'PROXY' ? 'GPU proxy · est' : block.kind === 'picture' ? 'I-frame · exact' : 'P-frame · decoded';
    }
    // scanline texture, as in the prototype's .frame::after
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    for (let y = 3; y < h; y += 4) ctx.fillRect(0, y, w, 1);
    const freeze = doc?.freezes.some((f) => target.kind !== 'source' && 'blockId' in f.target && f.target.blockId === (target as { blockId?: string }).blockId) ? 'fresh' : undefined;
    return { image: c.transferToImageBitmap(), state, route, freeze };
  }

  return {
    async nodeDefs() {
      return CATALOG;
    },
    updateProject(next) {
      doc = next;
    },
    setParam(next) {
      doc = next;
    },
    async libraryFolders() {
      return FOLDERS;
    },
    async setLibraryRoots() {
      return FOLDERS;
    },
    async listDir(dir) {
      return { path: dir, parent: null, dirs: [] };
    },
    async libraryClips(folder) {
      await sleep(120);
      return LIBRARY[folder] ?? LIBRARY['X:\\ExampleMedia\\footage'].filter((c) => hash(c.name + folder) % 3 !== 0);
    },
    // Raw-file preview (PREVIEW-API.md): painted art keyed by path + time; codecs WebCodecs could
    // not decode (ProRes, MJPEG…) answer as filmstrip-only, as the real engine does.
    async previewInfo(path) {
      const c = Object.values(LIBRARY).flat().find((x) => x.path === path);
      const p = c?.probe;
      const native = !!p && !/ProRes|MJPEG|HAP/.test(p.codec);
      return {
        path, mode: native ? 'native' : 'filmstrip', reason: native ? undefined : 'codec',
        container: path.split('.').pop() ?? '', codec: p?.codec ?? '?', width: p?.width ?? 1920, height: p?.height ?? 1080,
        rotation: 0, durationSec: p?.durationSec ?? 10, hdr: false, hasAudio: !!p?.audio,
      };
    },
    async previewFrame(path, timeSec, req) {
      await sleep(req.exact ? 40 : 6);
      const w = req.size.w, h = Math.round((req.size.w * 9) / 16);
      const c = new OffscreenCanvas(w, h);
      paintSource(c.getContext('2d')!, w, h, path, Math.round(timeSec * 24));
      return { image: c.transferToImageBitmap(), time: req.exact ? timeSec : Math.floor(timeSec / 2) * 2, exact: !!req.exact };
    },
    async filmstrip(path, opts) {
      const info = await this.previewInfo!(path);
      const n = opts?.count ?? 8, w = opts?.width ?? 160, h = Math.round((w * 9) / 16);
      const cells = await Promise.all(Array.from({ length: n }, async (_, i) => {
        const time = ((i + 0.5) / n) * info.durationSec;
        const c = new OffscreenCanvas(w, h);
        paintSource(c.getContext('2d')!, w, h, path, Math.round(time * 24));
        return { time, jpeg: new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 })).arrayBuffer()) };
      }));
      return { durationSec: info.durationSec, width: w, cells };
    },
    closePreview() {},
    releaseTrials() {},
    async setRating(path, n) {
      Object.values(LIBRARY).flat().filter((c) => c.path === path).forEach((c) => (c.rating = n));
    },
    async setTags(path, tags) {
      Object.values(LIBRARY).flat().filter((c) => c.path === path).forEach((c) => (c.tags = tags));
    },
    importClip(path, onProgress, opts) {
      return task(async (signal) => {
        const clip = Object.values(LIBRARY).flat().find((c) => c.path === path);
        if (!clip) throw new MoshpitError('MEDIA_FILE_MISSING', { path });
        if (clip.pass !== true) throw new MoshpitError('DECODE_UNSUPPORTED_CODEC', { path, codec: clip.probe.codec });
        for (const stage of ['probe', 'conform', 'proxy'] as const) {
          for (let f = 0; f <= 1; f += 0.25) {
            onProgress?.({ stage, fraction: f });
            await sleep(90, signal);
          }
        }
        // Like the real engine: a range is never dropped, it is clamped to at least one frame, and a slice is its own source.
        const fps = doc?.settings.fps ?? { num: 24, den: 1 };
        const range = opts?.range && validRange(opts.range, clip.probe.durationSec, fps);
        const key = range ? `${path}#${range.startSec}+${range.durSec}` : path;
        const sourceId = `src-${hash(key).toString(36)}` as SourceId;
        return {
          source: { id: sourceId, name: clip.name, path, sourceHash: hash(path).toString(16), probe: clip.probe, chapters: [], marks: [], motionSignature: null, ...(range ? { range } : {}) },
          conform: {
            id: `conf-${hash(key).toString(36)}` as never, sourceId, sourceHash: hash(path).toString(16), conformVersion: CONFORM_VERSION,
            args: ['-profile:v', 'main', '-bf', '0', '-flags', '+cgop', '-refs', '1'], ffmpegVersion: 'mock', path: path + '.conform.mp4',
            codecString: 'avc1.4d0028', profile: 'main', pocType: 2, refs: 1, gop: 12, fps,
            width: 1920, height: 1080, frames: Math.max(1, Math.round(((range?.durSec ?? clip.probe.durationSec) * fps.num) / fps.den)), keyframes: [], frameNumBits: 4, conformedHash: 'mock',
            moshable: true, notes: [], createdAt: new Date().toISOString(),
          },
        };
      });
    },
    detectCuts(sourceId, sensitivity) {
      return task(async (signal) => {
        const frames = 6528;
        await sleep(500, signal);
        const n = Math.round(4 + sensitivity * 1.3);
        return Array.from({ length: n }, (_, i) => ({
          id: `ch-${sourceId}-${i}` as never,
          start: Math.round((frames * i) / n + (i ? (hash(sourceId + i) % 40) - 20 : 0)),
          end: i === n - 1 ? frames : Math.round((frames * (i + 1)) / n + ((hash(sourceId + (i + 1)) % 40) - 20)),
          label: `Chapter ${i + 1}`,
          autoDetected: true,
          threshold: sensitivity / 10,
        }));
      });
    },
    frame,
    async audioPeaks(sourceId, buckets) {
      const s = hash(sourceId);
      const out = new Float32Array(buckets);
      for (let i = 0; i < buckets; i++) out[i] = (0.35 + 0.65 * Math.abs(Math.sin(i * 0.21 + s))) * (0.5 + ((i * 41 + s) % 13) / 26) * (0.6 + 0.4 * Math.sin(i * 0.045));
      return out;
    },
    freeze(target, range) {
      return task(async (signal) => {
        await sleep(700, signal);
        return { id: `frz-${Date.now()}` as never, target, range, key: 'mock', codec: 'raw-rgba8', fingerprint: 'mock', createdAt: new Date().toISOString() };
      });
    },
    render(job, onProgress) {
      return task(async (signal) => {
        if (/exists/i.test(job.outPath)) throw new MoshpitError('EXPORT_EXISTS', { path: job.outPath });
        onProgress({ fraction: 0, log: { level: 'info', text: `[queue] ${job.name}` } });
        onProgress({ fraction: 0.02, log: { level: 'info', text: `conform ${job.config.width}×${job.config.height} · ok` } });
        onProgress({ fraction: 0.04, log: { level: 'info', text: `encode ${job.config.format}` } });
        for (let f = 0.04; f < 1; f += 0.03 + (hash(job.id + f) % 5) / 100) {
          await sleep(120, signal);
          onProgress({ fraction: f });
        }
        onProgress({ fraction: 0.99, log: { level: 'info', text: 'decode check · mean err 2.1/255' } });
        onProgress({ fraction: 1, log: { level: 'ok', text: '✓ written (no overwrite)' } });
      });
    },
    verifyConforms(onProgress) {
      return task(async (signal) => {
        const srcs = doc?.resources.sources ?? [];
        const out = [];
        for (const [i, s] of srcs.entries()) {
          await sleep(250, signal);
          out.push({ sourceId: s.id, status: 'same' as const });
          onProgress?.({ done: i + 1, total: srcs.length });
        }
        return out;
      });
    },
    onError(fn) {
      errorListeners.add(fn);
      return () => errorListeners.delete(fn);
    },
  };
}
