// 3.2 containers on the canvas, in the real app: Shift-select two nodes → radial Layout › Group →
// a dashed container with its contents and domain path → double-click opens it (breadcrumb, Group
// input / output, no radial) → one level: no Group inside → the Group nodes stay on delete → back →
// undo is one step → Unpack gives the identical graph back (ids included).
// Run: node app/test/containers.e2e.mjs
import { launchApp } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-containers');
const ud = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const until = async (fn, ms = 5000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true; return false; };

const run = await launchApp({ root, userData: ud, port: 9348, env: { MOSHPIT_LIBRARY: path.join(root, 'fixtures'), MOSHPIT_NO_CLOSE_PROMPT: '1' } });
const win = run.win;
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));
const graph = () => win.evaluate(() => { const d = window.__moshpitState.doc(); const b = d.timeline.blocks.find((x) => x.id === d.view.activeBlock) ?? d.timeline.blocks[0]; return b.graph; });
const sorted = (g) => JSON.stringify({ n: [...g.nodes].sort((a, z) => (a.id < z.id ? -1 : 1)), e: [...g.edges].sort((a, z) => (a.id < z.id ? -1 : 1)) });
const node = (name) => win.locator('.react-flow__node', { has: win.locator('.gname', { hasText: new RegExp('^' + name + '$') }) });
const radial = async (...path) => {
  await win.locator('.canvaswrap .ctoolbar').getByRole('button', { name: /radial/ }).click();
  // Ring items are SVG sectors: pick them with their number keys, as radial.e2e does.
  for (const item of path) {
    await win.locator('[role=menuitem]').first().waitFor();
    const labels = await win.locator('[role=menuitem]').evaluateAll((els) => els.map((x) => x.getAttribute('aria-label') ?? ''));
    const i = labels.findIndex((l) => l.startsWith(item));
    if (i < 0) throw new Error(`no ${item} in the ring: ${labels.join(' | ')}`);
    await win.keyboard.press(String(i + 1));
  }
};
const shot = (n) => win.screenshot({ path: path.join(out, n + '.png') });

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  // A block with the VHS Decay look: Hold → Decode → Chroma drift → Posterize.
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: 'src-a.mp4' }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.convbar .hdnote').waitFor({ timeout: 120000 });
  await win.keyboard.press('Alt+2');
  const L = (sel) => win.locator(`.loupe[data-loupe="A"] ${sel}`);
  await L('.lbl').click();
  const tb = await L('.ztrack').boundingBox();
  await L('.ztrack').click({ position: { x: tb.width * 0.2, y: tb.height * 0.4 } }); await win.keyboard.press('i');
  await L('.ztrack').click({ position: { x: tb.width * 0.7, y: tb.height * 0.4 } }); await win.keyboard.press('o');
  await L('.ztools .tbtn.pop').click();
  await win.locator('.tl .blk').first().click();
  await win.locator('.recipe', { hasText: 'VHS Decay' }).click();
  await win.waitForTimeout(500);
  // Waxy's micro-pass: the readouts are compact and value-forward (the value outweighs its label).
  const ro = (l) => win.locator('.statusstrip .ro.sys', { has: win.locator('.lbl', { hasText: new RegExp('^' + l + '$') }) }).locator('.val');
  const rv = async (l) => (await ro(l).textContent())?.trim() ?? '';
  await until(async () => / ?ms$/.test(await rv('FRAME')), 8000);
  const vr = await rv('VRAM'), fr = await rv('FRAME'), ca = await rv('CACHE');
  check('readouts are compact: no space before the unit, no trailing .0', (vr === 'n/a' || /^\d+(\.\d)?\/\d+(\.\d)?GB$/.test(vr)) && /^\d+(\.\d)?ms$/.test(fr) && /^(\d+MB|\d+(\.\d)?GB|—)$/.test(ca), `VRAM ${vr} · FRAME ${fr} · CACHE ${ca}`);
  const sizes = await win.locator('.statusstrip .ro.sys').first().evaluate((el) => [parseFloat(getComputedStyle(el.querySelector('.val')).fontSize), parseFloat(getComputedStyle(el.querySelector('.lbl')).fontSize), el.getBoundingClientRect().height]);
  check('the value outweighs its label, and the strip keeps its height', sizes[0] >= 15 && sizes[1] <= 8 && Math.round((await win.locator('.statusstrip.hud').boundingBox()).height) === 34, JSON.stringify(sizes));
  await win.locator('.statusstrip.hud').screenshot({ path: path.join(out, '0-strip.png') });
  await win.keyboard.press('Alt+g');
  await win.locator('.graphbar').waitFor();
  await win.locator('.canvaswrap').getByRole('button', { name: /fit/ }).click();
  // The recipe merge: a look arrives as a container named after it, with its knobs on the face.
  const look = win.locator('.react-flow__node .gnode.container');
  check('VHS Decay arrives as a container with its four macros', await until(async () => (await look.count()) === 1 && /VHS Decay/.test(await look.locator('.gname').textContent()) && (await look.locator('.gb .npm').count()) === 4), await look.locator('.gname').textContent().catch(() => ''));
  await look.locator('.gname').click();
  const cvb = await win.locator('.canvaswrap .react-flow').boundingBox();
  await win.mouse.move(cvb.x + cvb.width / 2, cvb.y + 30);
  await win.keyboard.press('Control+Shift+g');
  check('…and unpacks into its chain (Hold, Decode, Chroma drift, Posterize)', await until(async () => (await look.count()) === 0 && (await graph()).nodes.filter((n) => ['mosh.hold', 'decode.webcodecs', 'fx.chroma-drift', 'fx.posterize'].includes(n.kind)).length === 4));
  await win.locator('.canvaswrap').getByRole('button', { name: /fit/ }).click();
  const before = await graph();

  // Shift-click multi-select (React Flow's default is Ctrl on Windows; every hint in the app says Shift).
  await node('Hold').locator('.gname').click();
  await win.keyboard.down('Shift');
  await node('Decode').locator('.gname').click();
  await node('Chroma drift').locator('.gname').click();
  await win.keyboard.up('Shift');
  const sel = await win.locator('.react-flow__node.selected .gname').allTextContents();
  check('with nodes selected, a visible Group button says how many', /Group 3/.test(await win.locator('.ws-node .canvaswrap .ctoolbar .cb.grp').textContent().catch(() => '')), await win.locator('.ws-node .canvaswrap .ctoolbar .cb.grp').textContent().catch(() => '(none)'));
  check('Shift-click adds to the selection', sel.length === 3 && ['Hold', 'Decode', 'Chroma drift'].every((n) => sel.includes(n)), sel.join(', '));

  await radial('Layout', 'Group');
  const box = win.locator('.react-flow__node .gnode.container');
  check('Layout › Group makes one container', await box.count() === 1);
  // textContent: React Flow keeps a re-rendered node hidden until it is measured, and innerText reads ''.
  const inner = await box.locator('.ctrinner').textContent(), dpath = await box.locator('.ctrpath').textContent();
  check('…dashed, showing its contents', inner === 'Hold · Decode · Chroma drift' && (await box.evaluate((el) => getComputedStyle(el).borderTopStyle)) === 'dashed', inner);
  check('…its domain path: one way in (the stream), one way out (the picture)', /^ENC → PIX$/i.test(dpath), dpath);
  check('…and its ports', (await box.locator('.prow.in').count()) === 1 && (await box.locator('.prow.out').count()) === 1);
  const off = await box.evaluate((el) => {
    const zoom = new DOMMatrix(getComputedStyle(el.closest('.react-flow__viewport')).transform).a, node = el.getBoundingClientRect();
    return [...el.querySelectorAll('.react-flow__handle.port')].map((h) => { const r = h.getBoundingClientRect(); const cx = r.left + r.width / 2; return Math.abs(cx - (h.classList.contains('react-flow__handle-left') ? node.left : node.right)) / zoom; });
  });
  check('…its sockets sit on its edges, like any node', off.length === 2 && off.every((d) => d <= 1), off.map((d) => d.toFixed(2)).join(', '));
  const g1 = await graph();
  check('the graph holds the container, Posterize stays outside', g1.nodes.some((n) => n.kind === 'group.container') && g1.nodes.some((n) => n.kind === 'fx.posterize') && !g1.nodes.some((n) => n.kind === 'mosh.hold' || n.kind === 'decode.webcodecs'));
  // A viewer on a container shows its output (the engine aliases it to the node feeding Group output).
  const lit = () => win.locator('.pvcard:has(.ctxlbl) .frameview canvas').first().evaluate((c) => {
    const x = c.getContext('2d') ?? null;
    if (!x || !c.width) return { lit: 0, w: c.width };
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
    return { lit: n / (d.length / 16), w: c.width };
  }).catch((e) => ({ lit: 0, err: String(e).slice(0, 80) }));
  let v = await lit();
  for (let i = 0; i < 100 && !(v.lit > 0.2); i++) { await win.waitForTimeout(150); v = await lit(); }
  const err = await win.locator('.pvcard:has(.ctxlbl) .frameerr').first().textContent().catch(() => null);
  check("the Node viewer shows the container's output", v.lit > 0.2, `${JSON.stringify(v)}${err ? ' · ' + err : ''}`);
  await shot('1-container');

  await box.dblclick();
  check('double-click opens it: the breadcrumb names the block and the container', await until(async () => (await win.locator('.blockcue .crumbs').count()) === 1), await win.locator('.blockcue').innerText());
  check('…with no radial opened by the same double-click', (await win.locator('[role=menuitem]').count()) === 0);
  const inside = await win.locator('.react-flow__node .gname').allTextContents();
  check('inside: Group input, the nodes, Group output', ['Group input', 'Hold', 'Decode', 'Chroma drift', 'Group output'].every((n) => inside.includes(n)), inside.join(', '));
  await shot('2-inside');
  await radial('Layout');
  const ring = await win.locator('[role=menuitem]').evaluateAll((els) => els.map((x) => x.getAttribute('aria-label') ?? ''));
  check('one level: no Group inside a container', !ring.some((t) => /^Group/.test(t)) && ring.some((t) => /^Serial/.test(t)), ring.join(' | '));
  await win.keyboard.press('Escape');
  await node('Group input').locator('.gname').click();
  await win.keyboard.press('Delete');
  check('Group input stays on delete (it is a port)', await until(async () => (await node('Group input').count()) === 1, 1000));

  await win.locator('.blockcue .crumb').click();
  check('back: the block graph again', await until(async () => (await win.locator('.blockcue .crumbs').count()) === 0 && (await box.count()) === 1));
  await win.locator('.topbar .brand').click();
  await win.keyboard.press('Control+z');
  check('undo takes the Group back in one step', await until(async () => sorted(await graph()) === sorted(before)));
  await win.keyboard.press('Control+Shift+z');
  check('redo groups again', await until(async () => (await box.count()) === 1));

  await box.locator('.gname').click();
  await radial('Layout', 'Unpack');
  check('Unpack gives the identical graph back (ids included)', await until(async () => sorted(await graph()) === sorted(before)));
  await shot('3-unpacked');

  // ---------- 3.3 macros ----------
  await win.locator('.topbar .brand').click();
  await win.keyboard.press('Control+z'); // the container back
  check('undo brings the container back after Unpack', await until(async () => (await box.count()) === 1));
  await box.dblclick();
  await until(async () => (await win.locator('.blockcue .crumbs').count()) === 1);
  await node('Chroma drift').locator('.gname').click();
  const expose = win.locator('.inspector-body .exposerow select');
  check('an inner node offers "Expose as a macro"', await expose.count() === 1, await win.locator('.inspector-body .exposerow .minilabel').textContent().catch(() => ''));
  await expose.selectOption({ label: 'Cb shift' });
  const macros = async () => (await graph()).nodes.find((n) => n.kind === 'group.container')?.body?.macros ?? [];
  check('Cb shift is now a macro of the container', await until(async () => (await macros()).length === 1 && (await macros())[0].label === 'Cb shift'), JSON.stringify((await macros()).map((m) => m.label)));
  await win.locator('.blockcue .crumb').click();
  check('the container face shows the macro', await until(async () => (await box.locator('.gb .npm').count()) === 1));
  await box.locator('.gname').click();
  check('the inspector reads a container, with Bypass', /Container · 3 nodes/.test(await win.locator('.inspector-body .ih').innerText()) && (await win.locator('.inspector-body .insp-actions button', { hasText: 'Bypass' }).count()) === 1, await win.locator('.inspector-body .ih').innerText());
  const program = () => win.locator('.pvcard:not(:has(.ctxlbl)) .frameview canvas').first().evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0; return h; });
  await win.waitForTimeout(1500);
  const pic0 = await program();
  const row = win.locator('.inspector-body .macrorow').first();
  await row.locator('.pv').click();
  await row.locator('input.typein').fill('0');
  await row.locator('input.typein').press('Enter');
  const box1 = async () => (await graph()).nodes.find((n) => n.kind === 'group.container');
  check('turning the macro sets its value on the container', await until(async () => (await box1()).params[(await macros())[0].key] === 0), JSON.stringify((await box1()).params));
  check('…and the Program changes (the inner param follows)', await until(async () => (await program()) !== pic0, 8000));
  // A/B the look in place: Bypass skips it, and un-bypassing gives back exactly the same picture.
  await win.waitForTimeout(1500);
  const on = await program();
  const byp = win.locator('.inspector-body .insp-actions button', { hasText: /Bypass/ });
  await byp.click();
  check('Bypass on a container skips the look (the Program changes)', await until(async () => (await program()) !== on, 8000) && (await box1()).bypass === true);
  await byp.click();
  check('…and un-bypassing restores the same picture, byte for byte', await until(async () => (await program()) === on, 8000));
  await shot('4-macro');

  // ---------- 3.4 / 3.5 polish: inspector Open / Unpack, Esc, Ctrl+G, Ctrl+Shift+G ----------
  const crumbs = () => win.locator('.blockcue .crumbs').count();
  await win.locator('.inspector-body .insp-actions button', { hasText: 'Open' }).click();
  check('inspector ▸ Open opens it', await until(async () => (await crumbs()) === 1));
  const cv = await win.locator('.canvaswrap .react-flow').boundingBox();
  await win.mouse.move(cv.x + cv.width / 2, cv.y + 30);
  await win.keyboard.press('Escape');
  check('Esc over the canvas leaves the container', await until(async () => (await crumbs()) === 0));
  await box.locator('.gname').click();
  // Focus-based (bug hunt): the pointer rests on the inspector, the canvas still has focus.
  const insp = await win.locator('.inspector-body').first().boundingBox();
  await win.mouse.move(insp.x + insp.width / 2, insp.y + 20);
  await win.keyboard.press('Control+Shift+g');
  check('Ctrl+Shift+G unpacks the selected container, with the pointer off the canvas', await until(async () => (await box.count()) === 0 && (await graph()).nodes.some((n) => n.kind === 'fx.chroma-drift')));
  await node('Posterize').locator('.gname').click();
  await win.mouse.move(cv.x + cv.width / 2, cv.y + 30);
  await win.keyboard.press('Control+g');
  check('Ctrl+G groups the selection', await until(async () => (await box.count()) === 1 && /Posterize/.test(await box.locator('.ctrinner').textContent())));
  await win.locator('.inspector-body .insp-actions button', { hasText: 'Unpack' }).click();
  check('inspector Unpack puts it back', await until(async () => (await box.count()) === 0 && (await node('Posterize').count()) === 1));
  // Deleting a container asks first, and Unpack instead keeps its nodes.
  await node('Posterize').locator('.gname').click();
  await win.locator('.ws-node .canvaswrap .ctoolbar .cb.grp').click();
  await until(async () => (await box.count()) === 1);
  await box.locator('.gname').click();
  await win.mouse.move(cv.x + cv.width / 2, cv.y + 30);
  await win.keyboard.press('Delete');
  const dlg = win.locator('[role=alertdialog]');
  check('deleting a container asks first (Unpack instead / Delete / Cancel)', await until(async () => (await dlg.count()) === 1) && /Unpack instead/.test(await dlg.innerText()));
  await dlg.getByRole('button', { name: 'Unpack instead' }).click();
  check('…and Unpack instead keeps its nodes', await until(async () => (await box.count()) === 0 && (await node('Posterize').count()) === 1));

  // ---------- 3.6 the look library: save a container, find it under Looks, place a copy ----------
  await node('Chroma drift').locator('.gname').click();
  await win.mouse.move(cv.x + cv.width / 2, cv.y + 30);
  await win.keyboard.press('Control+g');
  await until(async () => (await box.count()) === 1);
  await box.locator('.gname').click();
  await win.locator('.inspector-body .ctrname input').fill('My Bleed');
  await win.locator('.inspector-body .ctrname input').press('Enter');
  await win.locator('.inspector-body .insp-actions button', { hasText: 'Save as look' }).click();
  const looks = async () => win.evaluate(() => (window.__moshpitState.doc().components?.looks ?? []).map((l) => l.name));
  check('Save as look puts it in the project library', await until(async () => (await looks()).includes('My Bleed')), JSON.stringify(await looks()));
  await win.keyboard.press('Alt+g'); // back to MOSH, where the effect browser lives
  await win.getByRole('button', { name: '＋ Add effect' }).first().click();
  const panel = win.locator('aside.fxbrowser');
  const fxRow = (t) => panel.locator('.op', { has: win.locator('.nm', { hasText: t }) }).first();
  await panel.locator('.fxkinds button', { hasText: 'Looks' }).click();
  await panel.getByRole('tab', { name: 'All' }).click();
  const kinds = await panel.locator('.op .side').allTextContents();
  check('Looks shows looks only, yours among them', kinds.length > 0 && kinds.every((k) => /LOOK/.test(k)) && kinds.includes('YOUR LOOK'), [...new Set(kinds)].join(', '));
  const boxes0 = (await graph()).nodes.filter((n) => n.kind === 'group.container').length;
  await fxRow('My Bleed').click();
  await panel.locator('.op.sel .opacts .add').click();
  check('applying your look places a fresh copy of it', await until(async () => (await graph()).nodes.filter((n) => n.kind === 'group.container' && n.label === 'My Bleed').length === boxes0 + 1));
  // Library management in the browser: rename your look in place, then delete it (copies stay).
  const pick = async (t) => { for (let k = 0; k < 4 && !(await panel.locator('.op.sel', { has: win.locator('.nm', { hasText: t }) }).count()); k++) { await fxRow(t).click(); await win.waitForTimeout(300); } };
  await pick('My Bleed');
  const nameIn = panel.locator('.op.sel .ownlook input');
  await nameIn.fill('Bleed Two');
  await nameIn.press('Enter');
  check('rename your look in its row', await until(async () => (await looks()).join() === 'Bleed Two'), JSON.stringify(await looks()));
  await pick('Bleed Two');
  await panel.locator('.op.sel .ownlook button', { hasText: 'Delete look' }).click();
  await win.locator('[role=alertdialog]').getByRole('button', { name: 'Delete look' }).click();
  check('delete it from the library; placed copies stay', await until(async () => (await looks()).length === 0) && (await graph()).nodes.some((n) => n.kind === 'group.container' && n.label === 'My Bleed'));
  await panel.locator('.fxkinds button', { hasText: 'Operators' }).click();
  const ops = await panel.locator('.op .side').allTextContents();
  check('Operators shows single nodes only', ops.length > 0 && !ops.some((k) => /LOOK/.test(k)), [...new Set(ops)].join(', '));
  await panel.locator('.fxkinds button', { hasText: 'All' }).click();
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  check('ran to the end', false, String(e).split('\n').slice(0, 3).join(' / ') + ' · menu: ' + JSON.stringify(await win.locator('[role=menuitem]').evaluateAll((els) => els.map((x) => x.getAttribute('aria-label') ?? x.textContent)).catch(() => [])));
  await shot('fail').catch(() => {});
} finally {
  run.kill();
}
console.log(failed ? `containers: FAILED (${failed})` : 'containers: all ok');
process.exitCode = failed ? 1 : 0;
