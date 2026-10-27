// CT control additions (CONTROL-PROTOCOL.md v1, additive), end to end in the dev app over the real socket:
//   M1  discover carries the inspector selection; a CT `select` selects the node in the app; a click in the
//       graph pushes `selection` to the CT (one selection, both ways).
//   M3  clip.prev / clip.next step the slice loupe's clip; mark.*.nudge* move IN / OUT by `repeat` frames.
//   M4  render.start queues an export exactly as the Render button does.
// Run: node app/test/ct.e2e.mjs
import { launchApp } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-ct');
const ud = path.join(out, 'userdata');
const exports = path.join(out, 'exports');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const until = async (fn, ms = 5000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true; return false; };

const run = await launchApp({ root, userData: ud, port: 9346, env: { MOSHPIT_LIBRARY: path.join(root, 'fixtures'), MOSHPIT_NO_CLOSE_PROMPT: '1' } });
const win = run.win;
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));
const S = (fn) => win.evaluate(fn);

const send = async (file, to) => {
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: file }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  await win.locator('.convbar').getByRole('button', { name: new RegExp('^Send to ' + to) }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.convbar .hdnote').waitFor({ timeout: 120000 });
};

let ws;
try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  // Two project clips (B first, so A is the slice target at the end), a slice, and a block with a recipe.
  await send('src-c.mp4', 'B');
  await send('src-a.mp4', 'A');
  await win.keyboard.press('Alt+2');
  const L = (sel) => win.locator(`.loupe[data-loupe="A"] ${sel}`);
  await L('.lbl').click();
  const tb = await L('.ztrack').boundingBox();
  await L('.ztrack').click({ position: { x: tb.width * 0.2, y: tb.height * 0.4 } }); await win.keyboard.press('i');
  await L('.ztrack').click({ position: { x: tb.width * 0.7, y: tb.height * 0.4 } }); await win.keyboard.press('o');
  await L('.ztools .tbtn.pop').click();
  await win.locator('.tl .blk').first().click();
  await win.locator('.recipe', { hasText: 'VHS Decay' }).click();
  await win.waitForTimeout(300);
  await win.locator('.recipe', { hasText: 'Dream Melt' }).click(); // two looks: two containers, two slots
  await win.waitForTimeout(500);

  // The socket, as any client: endpoint file → hello.
  const ep = JSON.parse(fs.readFileSync(path.join(ud, 'control-endpoint.json'), 'utf8'));
  ws = new WebSocket(`ws://127.0.0.1:${ep.port}${ep.path}`);
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  await new Promise((r) => (ws.onopen = r));
  let nid = 0;
  const ask = async (m) => { const id = ++nid; ws.send(JSON.stringify({ ...m, id })); await until(() => got.some((x) => x.id === id), 5000); return got.find((x) => x.id === id); };
  const welcome = await (async () => { ws.send(JSON.stringify({ type: 'hello', protocol: 'moshpit-control', version: 1, client: 'ct-e2e', token: ep.token })); await until(() => got.length > 0); return got.shift(); })();
  check('welcome lists the new caps: selection, select', ['selection', 'select'].every((c) => welcome.caps?.includes(c)), (welcome.caps ?? []).join(','));

  // ---------- M1 ----------
  let t = await ask({ type: 'discover' });
  check('discover lists the new commands', ['clip.prev', 'clip.next', 'mark.in.nudgeBack', 'mark.in.nudgeForward', 'mark.out.nudgeBack', 'mark.out.nudgeForward', 'render.start'].every((c) => t.commands.includes(c)));
  check('discover carries `selected` (the inspector selection)', 'selected' in t, JSON.stringify(t.selected));
  check('the active block has at least two slots', t.slots.length >= 2, t.slots.map((s) => s.name).join(' → '));
  // 3.3: a look is one slot, its dials its macros; a macro write, then an undo, both come back.
  const vhs = t.slots.find((s) => s.name === 'VHS Decay');
  check('a look is one CT slot whose dials are its four macros, then bypass', !!vhs && vhs.params.length === 5 && vhs.params.slice(0, 4).every((p) => /\/param\/macro\d$/.test(p)) && vhs.params[4].endsWith('/param/bypass'), JSON.stringify(vhs?.params));
  await ask({ type: 'subscribe', paths: [vhs.params[3]] });
  const m0 = t.targets.find((x) => x.path === vhs.params[3]).value;
  const mw = await ask({ type: 'write', write: { target: vhs.params[3], generation: t.generation, value: 1, source: 'ct' } });
  check('a CT write on a macro is acked', mw?.type === 'ack' && mw.value === 1, JSON.stringify(mw));
  await new Promise((r) => setTimeout(r, 600));
  got.length = 0;
  await ask({ type: 'command', command: 'edit.undo' });
  check('…and its undo pushes the dial back to where the look sits', await until(() => got.some((m) => m.type === 'value' && m.path === vhs.params[3] && Math.abs(m.value - m0) < 1e-9), 4000), `${m0} · ${JSON.stringify(got.filter((m) => m.type === 'value'))}`);
  const second = t.slots[1];
  got.length = 0;
  const ack = await ask({ type: 'select', slot: 2, generation: t.generation });
  check('select slot 2 → ack with that node', ack?.type === 'ack' && ack.selected?.nodeId === second.nodeId && ack.selected?.slot === 2, JSON.stringify(ack));
  const blockId = t.activeBlock;
  const landed = await until(() => win.evaluate((b) => window.__moshpitState.doc().view.perBlock[b]?.selected?.[0], blockId).then((x) => x === second.nodeId));
  check('…the app selected it (the inspector selection is the CT selection)', landed, JSON.stringify(await win.evaluate(() => { const v = window.__moshpitState.doc().view; return { active: v.activeBlock, perBlock: v.perBlock }; })));
  check('…and pushed `selection` back once it landed', await until(() => got.some((m) => m.type === 'selection' && m.selected?.nodeId === second.nodeId && m.selected.slot === 2)), JSON.stringify(got.filter((m) => m.type === 'selection')));
  // The other way: a click on the first slot's node in the graph.
  await ask({ type: 'command', command: 'workspace.node' });
  const first = t.slots[0];
  got.length = 0;
  await win.locator(`.react-flow__node[data-id="${first.nodeId}"]`).click({ timeout: 10000 });
  check('a click in the graph pushes `selection` to the CT', await until(() => got.some((m) => m.type === 'selection' && m.selected?.nodeId === first.nodeId && m.selected.slot === 1)), JSON.stringify(got.filter((m) => m.type === 'selection')));
  check('…without bumping the generation (no re-discover)', !got.some((m) => m.type === 'targets-changed'));
  t = await ask({ type: 'discover' });
  check('re-discover agrees', t.selected?.nodeId === first.nodeId && t.selected.slot === 1, JSON.stringify(t.selected));
  const stale = await ask({ type: 'select', nodeId: 'no-such-node' });
  check('select of a node with no slot → CONTROL_STALE_TARGET', stale?.code === 'CONTROL_STALE_TARGET', JSON.stringify(stale));
  await ask({ type: 'command', command: 'workspace.mosh' });
  // Audit P2: removing a macro while a CT is connected re-discovers (the dial set changed).
  await ask({ type: 'select', nodeId: vhs.nodeId });
  await win.locator('.inspector-body .macrorow .macrox').first().waitFor({ timeout: 5000 });
  got.length = 0;
  await win.locator('.inspector-body .macrorow .macrox').first().click();
  check('removing a macro tells the CT to re-discover', await until(() => got.some((m) => m.type === 'targets-changed'), 4000), JSON.stringify(got.map((m) => m.type)));
  const t2 = await ask({ type: 'discover' });
  check('…and re-discovery shows the look with three dials (and bypass)', t2.slots.find((x) => x.nodeId === vhs.nodeId)?.params.length === 4, JSON.stringify(t2.slots.map((x) => [x.name, x.params.length])));
  await ask({ type: 'command', command: 'edit.undo' });

  // ---------- M3 ----------
  const slice = () => S(() => { const st = window.__moshpitState; const u = st.ui(); const l = u.loupes[u.sliceTarget]; const s = st.doc().resources.sources.find((x) => x.id === l.src); return { target: u.sliceTarget, src: l.src, frame: l.frame, marks: s?.marks[0] ? { in: s.marks[0].in, out: s.marks[0].out } : null, ids: st.doc().resources.sources.map((x) => x.id) }; });
  const s0 = await slice();
  check('slice target is loupe A on the first clip, with marks', s0.target === 'A' && !!s0.marks && s0.ids.length === 2, JSON.stringify(s0));
  const n1 = await ask({ type: 'command', command: 'mark.in.nudgeForward', repeat: 3 });
  const s1 = await slice();
  check('mark.in.nudgeForward ×3 moves IN 3 frames later, OUT unchanged', n1?.repeat === 3 && s1.marks.in === s0.marks.in + 3 && s1.marks.out === s0.marks.out, `${JSON.stringify(s0.marks)} → ${JSON.stringify(s1.marks)}`);
  // A run of nudges is one undo step (one history key per clip's marks, like dragging a mark).
  await ask({ type: 'command', command: 'edit.undo' });
  check('undo takes the nudge back', (await slice()).marks.in === s0.marks.in);
  await ask({ type: 'command', command: 'edit.redo' });
  check('redo puts it back', (await slice()).marks.in === s1.marks.in);
  await ask({ type: 'command', command: 'mark.out.nudgeBack', repeat: 2 });
  const s2 = await slice();
  check('mark.out.nudgeBack ×2 moves OUT 2 frames earlier', s2.marks.out === s0.marks.out - 2 && s2.marks.in === s1.marks.in, JSON.stringify(s2.marks));
  await ask({ type: 'command', command: 'mark.in.nudgeBack', repeat: 3 });
  await ask({ type: 'command', command: 'mark.out.nudgeForward', repeat: 2 });
  const s3 = await slice();
  check('…and back: the original marks', s3.marks.in === s0.marks.in && s3.marks.out === s0.marks.out, JSON.stringify(s3.marks));
  const i0 = s0.ids.indexOf(s0.src);
  await ask({ type: 'command', command: i0 === 0 ? 'clip.next' : 'clip.prev' });
  const c1 = await slice();
  check('clip.next / clip.prev step the slice loupe to the other project clip', c1.src === s0.ids[1 - i0] && c1.target === 'A', `${s0.src} → ${c1.src}`);
  await ask({ type: 'command', command: i0 === 0 ? 'clip.next' : 'clip.prev' });
  check('…and stop at the end of the list', (await slice()).src === c1.src);
  await ask({ type: 'command', command: i0 === 0 ? 'clip.prev' : 'clip.next' });
  check('…and step back', (await slice()).src === s0.src);

  // ---------- M4 ----------
  await win.keyboard.press('Alt+3');
  const outDir = win.locator('.exprow .pathfld input').last();
  await outDir.fill(exports);
  await outDir.blur();
  await win.waitForTimeout(300);
  const before = (await S(() => window.__moshpitState.renders())).length;
  const r = await ask({ type: 'command', command: 'render.start' });
  check('render.start acked', r?.type === 'ack', JSON.stringify(r));
  check('…queued one export, as the Render button does', await until(async () => (await S(() => window.__moshpitState.renders())).length === before + 1, 5000));
  const job = (await S(() => window.__moshpitState.renders())).at(-1);
  const ec = await S(() => window.__moshpitState.doc().exportConfig);
  check("…with the project's export settings and folder", job && !job.quick && job.config.format === ec.format && job.outPath.startsWith(exports), `${job?.config.format} → ${job?.outPath}`);
  check('…and it renders to a file', await until(async () => (await S(() => window.__moshpitState.renders())).at(-1).status === 'done', 10 * 60000) && fs.readdirSync(exports).length > 0, fs.existsSync(exports) ? fs.readdirSync(exports).slice(0, 3).join(', ') : 'no folder');
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  ws?.close();
  run.kill();
}
console.log(failed ? `ct: FAILED (${failed})` : 'ct: all ok');
process.exitCode = failed ? 1 : 0;
