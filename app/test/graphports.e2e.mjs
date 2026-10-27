// Phase 1.2: ports that explain themselves. Sockets are shaped and coloured by domain (encoded a
// square in --dom-enc, picture a circle in --dom-pix); while a wire is dragged, the sockets that
// would take it are lit and the rest dimmed; a refused drop says why at the socket, and a second
// decode offers its one-click fix. Screenshots in out/app-graphports/.
//   node app/test/graphports.e2e.mjs        (dev build: node app/build.mjs first)
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
process.env.MOSHPIT_CACHE_IN_PROFILE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-graphports');
const ud = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`], env: { ...process.env, MOSHPIT_LIBRARY: path.join(root, 'fixtures') } });
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));
await win.setViewportSize({ width: 1600, height: 1000 });
const node = (t) => win.locator('.ws-node .react-flow__node-mp', { hasText: t }).first();
const sock = (t, side, i = 0) => node(t).locator(`.react-flow__handle.${side}`).nth(i);
const centre = async (l) => { const b = await l.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
/** Press on a socket, move to `to` in steps (the drag in progress), run `during`, release. */
async function dragWire(from, to, during) {
  const a = await centre(from), z = typeof to.x === 'number' ? to : await centre(to);
  await win.mouse.move(a.x, a.y);
  await win.mouse.down();
  await win.mouse.move((a.x + z.x) / 2, (a.y + z.y) / 2, { steps: 6 });
  await win.mouse.move(z.x, z.y, { steps: 6 });
  if (during) await during();
  await win.mouse.up();
  await win.waitForTimeout(300);
}

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  // ---------- a block: Source → Hold → Decode → Chroma drift → Posterize → Output, and a free Invert ----------
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: 'src-a.mp4' }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  await win.locator('.convbar').getByRole('button', { name: /Add block/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.toasts .toast', { hasText: /Added \d+ f of src-a\.mp4/ }).first().waitFor({ timeout: 180000 });
  await win.keyboard.press('Alt+2');
  await win.locator('.tl .blk').first().click();
  await win.locator('.recipe', { hasText: 'VHS Decay' }).click();
  await win.keyboard.press('Alt+g');
  // 3.2: a look arrives as a container; this test is about the loose chain, so unpack it first.
  await win.locator('.ws-node .react-flow__node .gnode.container .gname').first().click({ timeout: 20000 });
  await win.locator('.inspector-body .insp-actions button', { hasText: 'Unpack' }).click();
  await node('Decode').waitFor({ timeout: 20000 });
  await win.locator('.ws-node .ni', { hasText: /^Invert/ }).first().click(); // added at the centre, unwired
  await node('Invert').waitFor({ timeout: 10000 });
  await win.locator('.ws-node').getByRole('button', { name: /Fit|fit/ }).first().click().catch(() => {});
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(out, '1-graph.png') });

  // ---------- shape and colour by domain ----------
  const look = (l) => l.evaluate((h) => { const s = getComputedStyle(h, '::after'); return { radius: s.borderTopLeftRadius, colour: s.borderTopColor, w: h.getBoundingClientRect().width }; });
  const enc = await look(sock('Source', 'source')), pix = await look(sock('Decode', 'source'));
  check('an encoded socket is a square in --dom-enc, a picture socket a circle in --dom-pix', enc.radius === '0px' && /217, 154, 60/.test(enc.colour) && pix.radius === '50%' && /75, 184, 201/.test(pix.colour), `enc ${enc.radius} ${enc.colour} · pix ${pix.radius} ${pix.colour}`);

  // ---------- Phase 1.3: Blender-style sockets, measured ----------
  const geo = await win.evaluate(() => {
    const vp = document.querySelector('.ws-node .react-flow__viewport');
    const zoom = new DOMMatrix(getComputedStyle(vp).transform).a;
    const bad = [];
    let n = 0, size = 0, hit = 0;
    for (const h of document.querySelectorAll('.ws-node .react-flow__node-mp .react-flow__handle.port')) {
      const r = h.getBoundingClientRect(), row = h.closest('.prow')?.getBoundingClientRect(), node = h.closest('.gnode')?.getBoundingClientRect();
      if (!row || !node) { bad.push('no row'); continue; }
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const edge = h.classList.contains('react-flow__handle-left') ? node.left : node.right;
      if (Math.abs(cx - edge) > 1 * zoom + 0.5 || Math.abs(cy - (row.top + row.height / 2)) > 1 * zoom + 0.5) bad.push(`${h.dataset.handleid}: dx ${(cx - edge).toFixed(1)} dy ${(cy - row.top - row.height / 2).toFixed(1)}`);
      size = Math.max(size, r.width / zoom);
      const b = getComputedStyle(h, '::before');
      hit = Math.max(hit, r.width / zoom - 2 * parseFloat(b.left)); // the inset is in canvas px, the box in screen px
      n++;
    }
    return { n, bad, size: Math.round(size), hit: Math.round(hit), zoom: +zoom.toFixed(2) };
  });
  check('every socket is centred on its node edge and its own row; 12px visible, 24px to hit', geo.n >= 12 && geo.bad.length === 0 && geo.size === 12 && geo.hit === 24, `${geo.n} sockets at zoom ${geo.zoom}, ${geo.size}px / ${geo.hit}px${geo.bad.length ? ' · off: ' + geo.bad.slice(0, 3).join(', ') : ''}`);
  const labelled = await win.locator('.ws-node .react-flow__node-mp', { hasText: 'Decode' }).first().locator('.prow .plabel').allInnerTexts();
  check('ports are labelled rows (Decode: its frame out, its stream in)', labelled.length === 2, labelled.join(' · '));

  // ---------- while dragging from Decode's picture output: what would take it ----------
  let lit = 0, dim = 0, invertLit = false, holdDim = false;
  // Empty space inside the canvas (past its edge, React Flow auto-pans the nodes away).
  const pane = await win.locator('.ws-node .react-flow__pane').first().boundingBox();
  await dragWire(sock('Decode', 'source'), { x: pane.x + pane.width * 0.5, y: pane.y + pane.height * 0.75 }, async () => {
    lit = await win.locator('.ws-node .react-flow__handle.port.can').count();
    dim = await win.locator('.ws-node .react-flow__handle.port.cannot').count();
    invertLit = /\bcan\b/.test((await sock('Invert', 'target').getAttribute('class')) ?? '');
    holdDim = /\bcannot\b/.test((await sock('Hold', 'target').getAttribute('class')) ?? '');
    await win.screenshot({ path: path.join(out, '2-dragging.png') });
  });
  check('dragging a picture wire lights the free picture input and dims the encoded and taken ones', lit >= 1 && dim >= 3 && invertLit && holdDim, `lit ${lit} · dimmed ${dim} · Invert lit ${invertLit} · Hold dimmed ${holdDim}`);
  check('…and the highlight clears when the drag ends', (await win.locator('.ws-node .react-flow__handle.port.can, .ws-node .react-flow__handle.port.cannot').count()) === 0);
  // That drag ended on empty space, which opens the add ring for the wire: close it, refit.
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  await win.locator('.ws-node').getByRole('button', { name: /fit/ }).first().click().catch(() => {});
  await win.waitForTimeout(500);

  // ---------- a refused drop explains itself at the socket ----------
  // Invert's output is a picture; Hold's input wants the encoded stream.
  await dragWire(sock('Invert', 'source'), sock('Hold', 'target'));
  const chip = win.locator('.wirerefusal');
  const said = await chip.innerText({ timeout: 3000 }).catch(() => '');
  await win.screenshot({ path: path.join(out, '3-refused.png') });
  check('a picture wire dropped on an encoded input says why, at the socket', /Needs ENC · got PIX/.test(said), said.replace(/\s+/g, ' ').slice(0, 120));
  await chip.getByRole('button', { name: 'Dismiss' }).click().catch(() => {});

  // ---------- a second decode offers its fix ----------
  await dragWire(sock('Source', 'source'), sock('Invert', 'target'));
  const second = await chip.innerText({ timeout: 3000 }).catch(() => '');
  const fixBtn = chip.getByRole('button', { name: 'Feed from Decode' });
  const offered = (await fixBtn.count()) === 1;
  if (offered) await fixBtn.click();
  await win.waitForTimeout(500);
  const fed = await win.locator('.toasts .toast', { hasText: /Fed from Decode/ }).count();
  await win.screenshot({ path: path.join(out, '4-fed.png') });
  check('Source → an effect beside the Mosh chain is refused as a second decode, with Feed from Decode; one click wires it', /decode its stream twice/i.test(second) && offered && fed === 1, `${second.replace(/\s+/g, ' ').slice(0, 80)} · fixed ${fed}`);
  // ---------- Phase 1.4: double-click a wire → a Reroute in it ----------
  await win.locator('.ws-node').getByRole('button', { name: /fit/ }).first().click().catch(() => {});
  await win.waitForTimeout(500);
  const from = await centre(sock('Decode', 'source'));
  const mid = await win.evaluate(({ x, y }) => {
    // The wire that starts at Decode's output: the path whose first point is on that socket.
    for (const p of document.querySelectorAll('.ws-node .react-flow__edge-path')) {
      const m = p.getScreenCTM(), a = p.getPointAtLength(0), z = p.getPointAtLength(p.getTotalLength() / 2);
      const sx = m.a * a.x + m.c * a.y + m.e, sy = m.b * a.x + m.d * a.y + m.f;
      if (Math.hypot(sx - x, sy - y) < 12) return { x: m.a * z.x + m.c * z.y + m.e, y: m.b * z.x + m.d * z.y + m.f };
    }
    return null;
  }, from);
  const before = await win.locator('.ws-node .react-flow__node-mp').count();
  if (mid) await win.mouse.dblclick(mid.x, mid.y);
  await win.waitForTimeout(500);
  const rr = win.locator('.ws-node .gnode.reroute');
  const rrw = (await rr.first().boundingBox().catch(() => null))?.width ?? 0;
  const ring = (await win.locator('.radialoverlay').count()) > 0;
  await win.screenshot({ path: path.join(out, '5-reroute.png') });
  check('double-clicking a wire puts a compact Reroute in it (and opens no add ring)', !!mid && (await win.locator('.ws-node .react-flow__node-mp').count()) === before + 1 && (await rr.count()) === 1 && rrw < 60 && !ring && (await rr.first().locator('.react-flow__handle.dom-pix').count()) === 2, `wire mid ${mid ? 'found' : 'not found'} · nodes ${before} → ${await win.locator('.ws-node .react-flow__node-mp').count()} · reroute ${Math.round(rrw)}px wide · ring ${ring}`);
  // ---------- Phase 1.5: a Value drives a param (a ghost on the canvas); the picture follows ----------
  await win.getByRole('button', { name: '＋ New Value' }).click();
  await win.locator('.valuetile').first().click(); // a folded tile, like an LFO's: open it
  const vrow = win.locator('.valuerow').first();
  await vrow.waitFor({ timeout: 5000 });
  const opts = await vrow.locator('select.linksel option').allInnerTexts();
  const pick = opts.findIndex((t) => /Chroma/.test(t));
  if (pick > 0) await vrow.locator('select.linksel').selectOption({ index: pick });
  await win.waitForTimeout(400);
  const ghost = await win.locator('.ws-node .lfoghost', { hasText: 'VALUE' }).count();
  const progHash = () => win.locator('section[aria-label="Preview"] .frameview canvas').first().evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h;
  });
  const typeValue = async (x) => {
    await vrow.locator('.lfoparams .pv').click();
    await vrow.locator('.lfoparams input.typein').fill(String(x));
    await vrow.locator('.lfoparams input.typein').press('Enter');
    let h = 0, prev = -1;
    for (let i = 0; i < 40 && h !== prev; i++) { prev = h; await win.waitForTimeout(250); h = await progHash(); } // until the frame settles
    return { h, now: await vrow.locator('.vnow').first().innerText() };
  };
  const lo = await typeValue(0), hi = await typeValue(1);
  check('a Value linked to a param shows as a ghost, and turning it changes the picture', pick > 0 && ghost === 1 && lo.h !== hi.h && lo.now !== hi.now, `linked "${opts[pick] ?? 'none'}" · ghost ${ghost} · ${lo.now} → ${hi.now} · frame ${lo.h} → ${hi.h}`);
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  failed++;
  console.log('FAIL ran to the end', String(e).split('\n')[0]);
}
try { execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
console.log(failed ? `graphports: ${failed} FAILED` : 'graphports: all ok');
process.exit(failed ? 1 : 0);
