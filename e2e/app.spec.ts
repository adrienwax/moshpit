// End to end through the real app: the UI window, the crash-isolated render worker and the
// MessagePort between them. Run `node app/build.mjs` first (npm run e2e does).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { newBlock, newEdge, newNode, newProject, withChain } from '../engine/src/project/build';
import { FS_HEAD, VS } from '../engine/src/gpu/backend';
import { MIX_GLSL } from '../engine/src/gpu/nodes';
import { collapseSelection, unpackContainer } from '../engine/src/graph/container';
import { DEF_BY_KIND } from '../engine/src/nodes/defs';
import * as crypto from 'node:crypto';
import type { ConformedSource, ProjectDoc, SourceClip } from '../engine/src/model';

const ROOT = path.resolve(__dirname, '..');
// Not Playwright's outputDir (out/e2e), which it empties on every run.
const OUT = path.join(process.env.EDENA_ARTIFACTS_DIR!, 'e2e-shots');
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  app = await electron.launch({
    // Its own profile: without one this ran in the real user's %APPDATA%\Moshpit 3 (their cache,
    // recents and settings), and conformed the fixtures into their cache (UI log, 2026-10-07).
    args: [path.join(process.env.MOSHPIT_BUILD_OUT!, 'main.cjs'), `--user-data-dir=${path.join(process.env.EDENA_SCRATCH_TEMP!, 'e2e-userdata')}`],
    env: { ...process.env, MOSHPIT_TEST: '1', MOSHPIT_LIBRARY: path.join(ROOT, 'fixtures') },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => { await app?.close(); });

test('the shell boots and the real render worker serves the registry', async () => {
  await expect(page).toHaveTitle(/Moshpit/);
  await page.waitForFunction(() => !!(window as any).__moshpitEngine, null, { timeout: 30_000 });
  const kinds: string[] = await page.evaluate(async () => (await (window as any).__moshpitEngine.nodeDefs()).map((d: { kind: string }) => d.kind));
  expect(kinds).toContain('fx.feedback');
  expect(kinds).toContain('seam.mosh');
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), title: w.getTitle() })));
  expect(windows.filter((w) => !w.visible).length).toBe(1); // the hidden render worker
  await page.screenshot({ path: path.join(OUT, 'shell.png') });
});

test('import → timeline → frame through the real engine', async () => {
  const imported: { source: SourceClip; conform: ConformedSource }[] = [];
  for (const name of ['src-a.mp4', 'src-c.mp4']) {
    imported.push(await page.evaluate(async (file) => (window as any).__moshpitEngine.importClip(file).promise, path.join(ROOT, 'fixtures', name)));
  }
  const doc: ProjectDoc = newProject('e2e');
  // Clips conform to whatever project was loaded at import time (here the UI's demo project).
  doc.settings.working = { w: imported[0].conform.width, h: imported[0].conform.height };
  doc.settings.fps = imported[0].conform.fps;
  for (const i of imported) { doc.resources.sources.push(i.source); doc.resources.conforms.push(i.conform); }
  doc.timeline.blocks = [withChain(newBlock('picture', imported[0].source.id, 0, 90), [{ kind: 'fx.plane-desync' }]), newBlock('motion', imported[1].source.id, 10, 100)];
  const r = await page.evaluate(async (d) => {
    const e = (window as any).__moshpitEngine;
    e.updateProject(d);
    try {
      const f = await e.frame({ kind: 'output', frame: 120 }, { w: 480, h: 270 });
      // Proxy-first import: a large frame is the proxy (≈) until the masters finish in the
      // background, then EXACT. Poll for it, as a viewer would on the next repaint.
      const first = await e.frame({ kind: 'output', frame: 120 }, { w: 1280, h: 720 });
      let g = first;
      for (let i = 0; g.state !== 'EXACT' && i < 600; i++) { await new Promise((r) => setTimeout(r, 100)); g = await e.frame({ kind: 'output', frame: 120 }, { w: 1280, h: 720 }); }
      return { small: { w: f.image.width, state: f.state, route: f.route }, first: { state: first.state, route: first.route }, large: { w: g.image.width, state: g.state, route: g.route } };
    } catch (err) { return { error: err }; }
  }, doc);
  expect((r as { error?: unknown }).error, JSON.stringify((r as { error?: unknown }).error)).toBeUndefined();
  expect(r.small.w).toBe(480);
  expect(r.first.state === 'EXACT' || r.first.route.includes('finalizing conform'), JSON.stringify(r.first)).toBe(true);
  expect(r.large.state).toBe('EXACT');
  expect(r.large.route).toContain('motion block');
  // Store the doc for the next test (same app instance).
  (globalThis as { e2eDoc?: ProjectDoc }).e2eDoc = doc;
});

// Phase 1.4: the utility nodes, in pixels on the real GPU. Each case is a one-block graph off the
// same Decode; frames are compared pixel for pixel (at most 1 level apart: one rounding).
test('utility nodes render as specified: Mix modes, Switch, Reroute', async () => {
  const base = (globalThis as { e2eDoc?: ProjectDoc }).e2eDoc!;
  type N = ReturnType<typeof newNode>;
  const graphDoc = (wire: (w: { dec: N; out: N; add: (kind: string, params?: Record<string, unknown>) => N; link: (a: N, z: N, port?: string) => void }) => void): ProjectDoc => {
    const d = structuredClone(base);
    const b = newBlock('picture', d.resources.sources[0].id, 0, 90);
    const g = b.graph;
    const src = g.nodes.find((n) => n.kind === 'source.clip')!, dec = g.nodes.find((n) => n.kind === 'decode.webcodecs')!, out = g.nodes.find((n) => n.kind === 'output.sink')!;
    g.edges = [newEdge(src.id, dec.id)];
    const add = (kind: string, params: Record<string, unknown> = {}) => { const n = newNode(kind, { x: 0, y: 0 }, params as never); g.nodes.push(n); return n; };
    const link = (a: N, z: N, port = 'in') => void g.edges.push(newEdge(a.id, z.id, 'out', port));
    wire({ dec, out, add, link });
    d.timeline.blocks = [b];
    return d;
  };
  const cases: Record<string, ProjectDoc> = {
    plain: graphDoc(({ dec, out, link }) => link(dec, out)),
    invert: graphDoc(({ dec, out, add, link }) => { const i = add('fx.invert'); link(dec, i); link(i, out); }),
    mix0: graphDoc(({ dec, out, add, link }) => { const i = add('fx.invert'), m = add('route.mix', { mix: 0, mode: 'mix' }); link(dec, i); link(dec, m, 'a'); link(i, m, 'b'); link(m, out); }),
    difference: graphDoc(({ dec, out, add, link }) => { const m = add('route.mix', { mix: 1, mode: 'difference' }); link(dec, m, 'a'); link(dec, m, 'b'); link(m, out); }),
    switch0: graphDoc(({ dec, out, add, link }) => { const i = add('fx.invert'), s = add('route.switch', { select: 0 }); link(dec, i); link(dec, s, 'a'); link(i, s, 'b'); link(s, out); }),
    switch1: graphDoc(({ dec, out, add, link }) => { const i = add('fx.invert'), s = add('route.switch', { select: 1 }); link(dec, i); link(dec, s, 'a'); link(i, s, 'b'); link(s, out); }),
    reroute: graphDoc(({ dec, out, add, link }) => { const r = add('route.reroute'), n = add('route.null'); link(dec, r); link(r, n); link(n, out); }),
  };
  const px = await page.evaluate(async (all) => {
    const e = (window as any).__moshpitEngine;
    const res: Record<string, number[]> = {};
    for (const [k, d] of Object.entries(all)) {
      e.updateProject(d);
      const f = await e.frame({ kind: 'output', frame: 30 }, { w: 160, h: 90 });
      const c = new OffscreenCanvas(f.image.width, f.image.height), g = c.getContext('2d')!;
      g.drawImage(f.image, 0, 0);
      res[k] = Array.from(g.getImageData(0, 0, c.width, c.height).data);
    }
    return res;
  }, cases);
  const maxDiff = (a: number[], b: number[]) => a.reduce((m, v, i) => (i % 4 === 3 ? m : Math.max(m, Math.abs(v - b[i]))), 0);
  const mean = (a: number[]) => a.reduce((s, v, i) => (i % 4 === 3 ? s : s + v), 0) / (a.length * 0.75);
  expect(maxDiff(px.plain, px.invert), 'invert changes the picture').toBeGreaterThan(50);
  expect(maxDiff(px.mix0, px.plain), 'Mix at 0 in mode mix is A').toBeLessThanOrEqual(1);
  expect(mean(px.difference), 'difference of a frame with itself is black').toBeLessThan(1);
  expect(maxDiff(px.switch0, px.plain), 'Switch 0 passes A').toBeLessThanOrEqual(1);
  expect(maxDiff(px.switch1, px.invert), 'Switch 1 passes B').toBeLessThanOrEqual(1);
  expect(maxDiff(px.reroute, px.plain), 'Reroute and Null change nothing').toBeLessThanOrEqual(1);
});

// 3.2 Phase 3, 3.0a: a container compiles by inlining, so collapsing nodes into one (and unpacking
// it) must render exactly what the plain graph renders: Program frames byte for byte, and a PNG
// export file for file. The look crosses the Decode (Hold → Decode → Chroma drift), D2.
test('containers: collapse and unpack render identical frames and export identical bytes', async () => {
  const base = (globalThis as { e2eDoc?: ProjectDoc }).e2eDoc!;
  const plain = structuredClone(base);
  plain.timeline.blocks[1] = withChain(plain.timeline.blocks[1], [{ kind: 'mosh.hold' }, { kind: 'fx.chroma-drift' }, { kind: 'fx.posterize' }]);
  const g = plain.timeline.blocks[1].graph;
  const pick = ['mosh.hold', 'decode.webcodecs', 'fx.chroma-drift'].map((k) => g.nodes.find((n) => n.kind === k)!.id);
  let k = 0;
  const ids = { container: 'ctr-e2e' as never, groupIn: 'gin-e2e' as never, groupOut: 'gout-e2e' as never, edge: () => `xe2e${++k}` as never };
  const portType = (n: { kind: string }, port: string) => DEF_BY_KIND.get(n.kind)?.outputs.find((p) => p.key === port)?.type;
  const collapsed = structuredClone(plain);
  collapsed.timeline.blocks[1].graph = collapseSelection(g, pick, ids, portType);
  const unpacked = structuredClone(collapsed);
  unpacked.timeline.blocks[1].graph = unpackContainer(collapsed.timeline.blocks[1].graph, 'ctr-e2e' as never);
  const dir = path.join(ROOT, 'out', 'e2e-containers');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cases = { plain, collapsed, unpacked };
  const r = await page.evaluate(async ({ cases, dir }) => {
    const e = (window as any).__moshpitEngine;
    const out: Record<string, { frames: number[][]; err?: string }> = {};
    for (const [name, d] of Object.entries(cases)) {
      e.updateProject(d);
      const frames: number[][] = [];
      for (const f of [92, 110, 150]) {
        const x = await e.frame({ kind: 'output', frame: f }, { w: 320, h: 180 });
        const c = new OffscreenCanvas(x.image.width, x.image.height), cx = c.getContext('2d')!;
        cx.drawImage(x.image, 0, 0);
        frames.push(Array.from(cx.getImageData(0, 0, c.width, c.height).data));
      }
      let err: string | undefined;
      try { await e.render({ id: `ctr-${name}`, name, config: { format: 'png-seq', width: 320, height: 180, audio: false, range: [95, 104] }, outPath: `${dir}/${name}` }, () => {}).promise; } catch (x: any) { err = x?.code ?? String(x); }
      out[name] = { frames, err };
    }
    return out;
  }, { cases, dir });
  for (const name of Object.keys(cases)) expect(r[name].err, name).toBeUndefined();
  const same = (a: number[][], b: number[][]) => a.every((f, i) => f.length === b[i].length && f.every((v, j) => v === b[i][j]));
  expect(same(r.collapsed.frames, r.plain.frames), 'collapsed frames = plain, byte for byte').toBe(true);
  expect(same(r.unpacked.frames, r.plain.frames), 'unpacked frames = plain, byte for byte').toBe(true);
  const files = (name: string) => fs.readdirSync(path.join(dir, name)).sort().map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name, f))).digest('hex'));
  expect(files('plain').length).toBe(10);
  expect(files('collapsed'), 'collapsed export = plain, file for file').toEqual(files('plain'));
  expect(files('unpacked'), 'unpacked export = plain, file for file').toEqual(files('plain'));
});

// Phase 1 hardening: Mix's shaderVersion went 1 → 2 (blend modes), so every freeze with a Mix
// re-renders once. Golden proof that the re-render is output-identical: Mix@2's mode 0 against the
// Mix@1 body, both as compiled engine shaders on this GPU into RGBA16F (the engine's working
// format), compared bit for bit at every k from 0 to 1, without and with a mask.
const MIX_V1_GLSL = `
      void main(){
        float m = u[11] > 0.5 ? dot(texture(t2, v).rgb, vec3(0.2126, 0.7152, 0.0722)) : 1.0;
        o = mix(texture(t0, v), texture(t1, v), clamp(u[0] * m, 0.0, 1.0));
      }`;
test('golden: Mix mode 0 is bit-identical to Mix@1 across k, with and without a mask', async () => {
  const r = await page.evaluate(({ VS, HEAD, OLD, NEW }) => {
    const W = 64, H = 64;
    const gl = new OffscreenCanvas(W, H).getContext('webgl2')!;
    if (!gl.getExtension('EXT_color_buffer_float')) return { error: 'no EXT_color_buffer_float' };
    const shader = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'compile'); return s; };
    const program = (body: string) => { const p = gl.createProgram()!; gl.attachShader(p, shader(gl.VERTEX_SHADER, VS)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, HEAD + body)); gl.linkProgram(p); return p; };
    let seed = 7;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const texture = (data?: Float32Array) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, W, H);
      if (data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, data);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
      return t;
    };
    const ins = [0, 1, 2].map(() => texture(new Float32Array(W * H * 4).map(() => rnd() * 1.25)));
    const out = texture();
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    gl.bindVertexArray(gl.createVertexArray());
    gl.viewport(0, 0, W, H);
    const run = (p: WebGLProgram, k: number, mask: boolean) => {
      gl.useProgram(p);
      const u = new Float32Array(16);
      u[0] = k; u[1] = 0; u[11] = mask ? 1 : 0;
      gl.uniform1fv(gl.getUniformLocation(p, 'u'), u);
      ins.forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(gl.getUniformLocation(p, `t${i}`), i); });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, px);
      return new Uint32Array(px.buffer);
    };
    const pOld = program(OLD), pNew = program(NEW);
    const ks = [0, 0.05, 0.1, 0.25, 1 / 3, 0.5, 0.6, 2 / 3, 0.75, 0.9, 0.99, 1];
    let differ = 0, compared = 0, nonTrivial = 0;
    for (const mask of [false, true]) for (const k of ks) {
      const a = run(pOld, k, mask), b = run(pNew, k, mask);
      for (let i = 0; i < a.length; i++) { compared++; if (a[i] !== b[i]) differ++; }
      if (k > 0 && k < 1 && a.some((x, i) => x !== run(pOld, 0, mask)[i])) nonTrivial++;
    }
    return { differ, compared, nonTrivial, renderer: String(gl.getParameter(gl.RENDERER)) };
  }, { VS, HEAD: FS_HEAD, OLD: MIX_V1_GLSL, NEW: MIX_GLSL });
  expect((r as { error?: string }).error).toBeUndefined();
  expect(r.compared).toBe(2 * 12 * 64 * 64 * 4);
  expect(r.nonTrivial, 'mid-k frames really differ from k = 0 (the test is not vacuous)').toBeGreaterThan(10);
  expect(r.differ, `bits that differ on ${r.renderer}`).toBe(0);
});

test('a worker crash is isolated: the UI survives, hears WORKER_CRASHED, and the next frame works', async () => {
  await page.evaluate(() => {
    (window as any).__errs = [];
    (window as any).__moshpitEngine.onError((e: { code: string }) => (window as any).__errs.push(e.code));
  });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => !w.isVisible())?.webContents.forcefullyCrashRenderer(); });
  await page.waitForFunction(() => (window as any).__errs.includes('WORKER_CRASHED'), null, { timeout: 30_000 });
  const after = await page.evaluate(async () => {
    const f = await (window as any).__moshpitEngine.frame({ kind: 'output', frame: 30 }, { w: 640, h: 360 });
    return { w: f.image.width, state: f.state };
  });
  expect(after.w).toBe(640);
  expect(await page.title()).toMatch(/Moshpit/);
  await page.screenshot({ path: path.join(OUT, 'after-crash.png') });
});

test('the CT control server is live in the app (CONTROL-PROTOCOL.md v1)', async () => {
  const { default: WebSocket } = await import('ws');
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const ep = JSON.parse(fs.readFileSync(path.join(userData, 'control-endpoint.json'), 'utf8'));
  expect(ep).toMatchObject({ v: 1, path: '/control', protocol: 'moshpit-control' });
  const ws = new WebSocket(`ws://127.0.0.1:${ep.port}${ep.path}`);
  const msgs: any[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', protocol: 'moshpit-control', version: 1, client: 'e2e', token: ep.token }));
  ws.send(JSON.stringify({ type: 'discover', id: 1 }));
  await expect.poll(() => msgs.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  expect(msgs[0]).toMatchObject({ type: 'welcome', version: 1 });
  expect(msgs[1]).toMatchObject({ type: 'targets', id: 1 });
  expect(msgs[1].commands).toContain('block.freeze');
  ws.close();
});
