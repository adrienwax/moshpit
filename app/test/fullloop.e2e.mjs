// The whole app on the REAL engine and REAL footage, through the UI only:
//   import + conform the real 1080p GoPro clip (full 2 min) → import a 20 s cut of it carrying
//   an AAC track (made here with ffmpeg: video stream copied untouched) → slice a picture block
//   and a motion block from that clip → apply a real recipe (Mosh + image ops) → per-node viewer
//   + scopes from real pixels → freeze the motion block → export H.264 with clip audio + audio
//   mirror → ffprobe the file → save → New → Open → save again byte-identical.
// Why one clip on the timeline: the engine refuses to stitch the GoPro next to the untagged
// fixtures (their conformed SPS differ in colour tags — UI log E12), so both blocks share one.
// Needs a build (node app/build.mjs) and the spike's fixtures-real folder. Prints timings.
//   node app/test/fullloop.e2e.mjs
// Packaged: MOSHPIT_EXE=<path to the built .exe> runs the same loop through that exe, driven
// over CDP (a portable exe is a launcher, so Playwright's electron.launch cannot attach to it).
import { _electron as electron, chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Test windows open off-screen and never take focus (electron/main.ts).
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const real = process.env.MOSHPIT_REAL_FOOTAGE ?? path.join(root, '..', 'moshpit-v3-spike', 'fixtures-real');
const ffprobe = process.env.FFPROBE ?? path.join(root, '..', '..', 'toolkit', 'bin', 'ffprobe.exe');
const out = path.join(root, 'out', 'app-fullloop');
const userData = path.join(out, 'userdata');
const exports = path.join(out, 'exports');
const projectFile = path.join(out, 'fullloop.moshpit.json');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join(real, 'gopro-uw-1080p.mp4'))) {
  console.log(`SKIP: real footage not found at ${real} (set MOSHPIT_REAL_FOOTAGE)`);
  process.exit(0);
}
// Real footage with real audio: 20 s of the GoPro (video copied) + a 220 Hz AAC track.
const media = path.join(root, 'out', 'fullloop-media');
const withAudio = path.join(media, 'gopro-20s-audio.mp4');
if (!fs.existsSync(withAudio)) {
  fs.mkdirSync(media, { recursive: true });
  const ffmpeg = path.join(path.dirname(ffprobe), 'ffmpeg.exe');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', '30', '-t', '20', '-i', path.join(real, 'gopro-uw-1080p.mp4'), '-f', 'lavfi', '-t', '20', '-i', 'sine=frequency=220:sample_rate=48000,aformat=channel_layouts=stereo,volume=0.3', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', withAudio]);
}

let failed = 0;
const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${lap()}] ${name}${ok && !detail ? '' : '  ' + detail}`);
  if (!ok) failed++;
};
let step = 'start';
const at = (name) => {
  step = name;
  if (process.env.TRACE) console.log(`.. [${lap()}] ${name}`);
};
const timed = async (fn) => {
  const s = Date.now();
  await fn();
  return ((Date.now() - s) / 1000).toFixed(1) + 's';
};

const env = { ...process.env, MOSHPIT_TEST: '1', MOSHPIT_DIALOG_PATH: projectFile, MOSHPIT_LIBRARY: [real, media].join(path.delimiter) };
const exe = process.env.MOSHPIT_EXE;
let pid, win;
if (exe) {
  const child = spawn(exe, [`--user-data-dir=${userData}`, '--remote-debugging-port=9333'], { env, stdio: 'ignore' });
  pid = child.pid;
  let browser;
  for (let i = 0; i < 120 && !browser; i++) browser = await chromium.connectOverCDP('http://127.0.0.1:9333').catch(() => new Promise((r) => setTimeout(r, 1000)));
  if (!browser) throw new Error(`no CDP from ${exe}`);
  for (let i = 0; i < 60 && !win; i++) {
    win = browser.contexts().flatMap((c) => c.pages()).find((pg) => pg.url().endsWith('index.html'));
    if (!win) await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`packaged: ${exe}`);
} else {
  const app = await electron.launch({ args: [path.join(root, 'app/dist/main.cjs'), `--user-data-dir=${userData}`], cwd: root, timeout: 30000, env });
  pid = app.process().pid;
  win = await app.firstWindow();
}
const pageErrors = [];
win.on('pageerror', (e) => pageErrors.push(String(e)));
const shot = (n) => win.screenshot({ path: path.join(out, n + '.png') });

try {
  await win.waitForSelector('.topbar', { timeout: 20000 });
  check('the real render engine is in use', (await win.locator('.pill', { hasText: 'render engine' }).count()) === 1);

  // ---------- import + conform ----------
  // quality: pick a conform preset in the Import / conform pane first (1 Smooth · 2 Balanced · 3 Fast).
  const importClip = async (folder, file, quality) => {
    await win.keyboard.press('Alt+1');
    // Exact folder name: 'fixtures' must not match 'fixtures-real'.
    at(`select folder ${folder}`);
    await win.locator('.tnode').filter({ has: win.getByText(folder, { exact: true }) }).first().click({ timeout: 30000 });
    at(`select clip ${file}`);
    await win.locator('.gcell', { hasText: file }).click({ timeout: 60000 });
    if (quality) {
      at(`pick conform quality ${quality}`);
      await win.locator('.convbar .qfld button[aria-haspopup="menu"]').click();
      await win.keyboard.press({ Smooth: '1', Balanced: '2', Fast: '3' }[quality]);
      await win.locator('.convbar .qfld button[aria-haspopup="menu"]', { hasText: quality }).waitFor({ timeout: 5000 });
    }
    at(`import ${file}`);
    await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click(); await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
    // Over a minute with nothing marked: Use asks before conforming all of it. This loop wants it all.
    const whole = win.locator('[role=alertdialog]', { hasText: /Conform .* of / });
    if (await whole.waitFor({ timeout: 2000 }).then(() => true, () => false)) await whole.getByRole('button', { name: 'Conform it all' }).click();
    // First import into an empty project: adopt the clip's frame rate.
    const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
    if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
    await win.locator('.convbar .hdnote').waitFor({ timeout: 15 * 60000 });
  };
  const goproT = await timed(() => importClip('fixtures-real', 'gopro-uw-1080p.mp4', 'Balanced'));
  check(`imported the real 1080p GoPro clip, usable on its proxy (${goproT})`, true);
  // Proxy-first: usable now, the full-quality master still encoding in the background.
  const badge = await win.locator('.convbar .cbadge').innerText().catch(() => '');
  check('the clip shows "usable now · finalizing" while its master encodes', /usable now/i.test(badge), badge);
  check('the status strip shows the master finalizing', (await win.locator('.statusstrip', { hasText: /FINALIZING/i }).count()) === 1);
  await shot('1-browse-real');
  check('the imported clip now shows real frames in the big preview', (await win.locator('.frameview.bigpv canvas').count()) === 1 && (await win.locator('.frameview.bigpv .frameerr').count()) === 0);
  const audioT = await timed(() => importClip('fullloop-media', 'gopro-20s-audio.mp4', 'Fast'));
  check(`imported + conformed the real-footage clip with an AAC track (${audioT})`, true);

  // ---------- slice: a picture block from the GoPro, a motion block from src-a ----------
  at('slice');
  await win.keyboard.press('Alt+2');
  const slice = async (clipName, from, to, button) => {
    await win.locator('.clip', { hasText: clipName }).click();
    // The slice tier is folded into the slots: mark on slot A's own timeline, then its ⤓ block
    // (the first block is a picture block, later ones motion).
    const lane = win.locator('.loupe[data-loupe="A"] .ztrack');
    const box = await lane.boundingBox();
    await lane.click({ position: { x: box.width * from, y: box.height * 0.7 } });
    await win.keyboard.press('i');
    await lane.click({ position: { x: box.width * to, y: box.height * 0.7 } });
    await win.keyboard.press('o');
    await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click();
  };
  await slice('gopro-20s-audio', 0.1, 0.2);
  await slice('gopro-20s-audio', 0.4, 0.75);
  await win.locator('.blk').nth(1).waitFor();
  check('two blocks on the timeline: picture + motion', (await win.locator('.blk.pic').count()) === 1 && (await win.locator('.blk.mot').count()) === 1);

  // ---------- a real recipe on the motion block ----------
  at('recipe');
  await win.locator('.blk.mot').click();
  await win.locator('.recipe', { hasText: 'VHS Decay' }).click();
  await win.waitForTimeout(600);
  // 3.2: a look arrives as ONE container on Compose's graph, between Source and Output; its chain
  // (the Mosh op, the drawn Decode, then the image ops) reads left to right on its face.
  const xOf = async (t) => (await win.locator('.ws-mosh .react-flow__node-mp', { has: win.locator('.gname', { hasText: t }) }).first().boundingBox())?.x ?? NaN;
  const look = win.locator('.ws-mosh .react-flow__node-mp .gnode.container');
  const [sx, lx, ox] = [await xOf('Clip'), await xOf('VHS Decay'), await xOf('Output')];
  check("VHS Decay applied as one look on Compose's graph, between Source and Output", (await look.count()) === 1 && sx < lx && lx < ox, `Source ${sx} · look ${lx} · Output ${ox}`);
  const inside = (await look.locator('.ctrinner').textContent()) ?? '';
  check('its chain inside: the Mosh op, the Decode, then the image ops', inside === 'Hold · Decode · Chroma drift · Posterize', inside);

  // ---------- per-node viewer + scopes from real pixels ----------
  at('node viewer');
  await win.keyboard.press('Alt+g');
  await win.locator('.react-flow__node-mp', { hasText: 'Chroma drift' }).waitFor({ timeout: 20000 });
  const viewT = await timed(async () => {
    await win.locator('.react-flow__node-mp', { hasText: 'Chroma drift' }).locator('.viewdot').click();
    await win.locator('section[aria-label="Node viewer"] .frameview .fx').waitFor({ timeout: 60000 });
  });
  const viewErr = await win.locator('section[aria-label="Node viewer"] .frameerr').count();
  const viewText = await win.locator('section[aria-label="Node viewer"] .frameview').innerText().catch(() => '');
  check(`node viewer shows the frame at Chroma drift (${viewT})`, viewErr === 0, viewText);
  // The viewer must evaluate inside its own (motion) block, not wherever the timeline starts.
  check('node viewer renders a frame of the motion block', /motion block/.test(viewText), viewText);
  await shot('2-node-real');
  at('scopes');
  await win.keyboard.press('Alt+2');
  // The labelled scope panel reports a measured frame, with all three plots and a near-white count.
  const scopes = win.locator('.scope-panel[aria-label="MOSH · Program scopes"]');
  const measured = () => scopes.locator('.scope-status', { hasText: /^Measured$/ }).waitFor({ timeout: 60000 });
  const scopeT = await timed(measured);
  const clipPct = await scopes.locator('.scope-panel-foot > span').last().innerText();
  const populated = await scopes.locator('.scope-plot canvas').evaluateAll(canvases => canvases.map(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((value, i) => i % 4 === 3 && value > 0);
  }));
  check(`scopes measured from the real output frame (${scopeT})`, /^\d+(?:\.\d+)?% near white\b/.test(clipPct) && populated.length === 3 && populated.every(Boolean), clipPct);

  // ---------- the selection drives the panes (UX round 2: Block, Effects, Render are panes, no tabs) ----------
  at('selection drives the panes');
  const gnode = (t) => win.locator('.ws-mosh .react-flow__node-mp', { hasText: t }).first();
  // The node inspector's own header in Effects (the recipe list above also names these effects).
  const nodeHead = async () => (await win.locator('section[aria-label="Effects"] .inspector-body .ih').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const waitHead = async (re) => { for (let i = 0; i < 30 && !re.test(await nodeHead()); i++) await win.waitForTimeout(100); return re.test(await nodeHead()); };
  await win.locator('.blk.mot').click();
  await gnode('Output').click();
  check('selecting a node shows it in Effects', await waitHead(/Output/), await nodeHead());
  await gnode('VHS Decay').click();
  check('selecting the look follows in Effects, with its knobs', await waitHead(/VHS Decay/) && (await win.locator('section[aria-label="Effects"] .inspector-body .macrorow').count()) === 4, await nodeHead());
  await win.locator('.blk.pic').click();
  const blockHeader = win.locator('section[aria-label="Block information"] header');
  await blockHeader.getByText('Block 1', { exact: true }).waitFor();
  check('selecting a block shows it in the Block sheet', await blockHeader.getByText('Picture', { exact: true }).count() === 1 && await blockHeader.locator('.block-number').innerText() === '01', await blockHeader.innerText());

  // ---------- playback: output throttled, node view held, scopes paused (P1-C, audit) ----------
  at('playback');
  await win.locator('.blk.mot').click();
  await gnode('Chroma').click();
  const fnOf = (pane) => win.locator(`section[aria-label="${pane}"] .frameview .fn`).first().innerText().catch(() => '');
  await win.locator(`section[aria-label="Context preview"] .frameview .fx`).waitFor({ timeout: 60000 });
  const [out0, node0] = [await fnOf('Program'), await fnOf('Context preview')];
  await measured();
  const scopeBeforePlay = await scopes.locator('.scope-plot canvas').evaluateAll(canvases => canvases.map(canvas => canvas.toDataURL()));
  await win.evaluate(() => { const a = window.__moshpitFrameAsks; for (const k in a) a[k] = 0; });
  await win.locator('[aria-label="Transport"] .tbtn').first().click();
  await win.waitForTimeout(3000);
  const [out1, node1] = [await fnOf('Program'), await fnOf('Context preview')];
  const held = await win.locator('section[aria-label="Context preview"] .viewnote').innerText();
  const scopeStatus = await scopes.locator('.scope-status').innerText();
  const scopeDuringPlay = await scopes.locator('.scope-plot canvas').evaluateAll(canvases => canvases.map(canvas => canvas.toDataURL()));
  const asks = await win.evaluate(() => ({ ...window.__moshpitFrameAsks }));
  await win.locator('[aria-label="Transport"] .tbtn').first().click();
  // Deterministic, load-independent (P1-C): before the fix every playhead tick asked for an output
  // AND a node frame (2 per tick); now the node view asks none and the output at most one per tick.
  const ticks = Number(/\d+/.exec(out1)?.[0]) - Number(/\d+/.exec(out0)?.[0]);
  check(`playing: frame requests over ${ticks} frames: output ${asks.output}, node ${asks.node} (was ~${ticks} + ${ticks})`, asks.node === 0 && asks.output > 0 && asks.output <= ticks, JSON.stringify(asks));
  check('playing: the output preview keeps moving (throttled, not frozen)', out1 !== out0, `${out0} → ${out1}`);
  check('playing: the node preview holds its frame, and says so', node1 === node0 && /held while playing/.test(held), `${node0} → ${node1} · ${held}`);
  check('playing: the scopes pause (no new measurement)', scopeStatus === 'Paused during playback' && scopeBeforePlay.length === 3 && scopeBeforePlay.every((image, i) => image === scopeDuringPlay[i]), scopeStatus);

  // ---------- the Program monitor's own transport (Waxy) ----------
  at('program transport');
  const ptc = async () => Number(/Frames\s+(\d+)\s*\//.exec(await win.locator('.progctl .program-frame').innerText())?.[1]);
  const pctl = win.locator('[aria-label="Program transport"]');
  await pctl.getByRole('button', { name: 'To the start', exact: true }).click();
  const p0 = await ptc();
  await pctl.getByRole('button', { name: 'Step forward one frame', exact: true }).click();
  await pctl.getByRole('button', { name: 'Step forward one frame', exact: true }).click();
  const p2 = await ptc();
  await pctl.getByRole('button', { name: 'Step back one frame', exact: true }).click();
  check('Program transport: start, then step +2 and −1 frame', p0 === 0 && p2 === 2 && (await ptc()) === 1, `${p0} → ${p2} → ${await ptc()}`);
  const sb = await win.locator('.progctl .pseek').boundingBox();
  await win.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2);
  const mid = await ptc(), lastF = Number(await win.locator('.progctl .pseek').getAttribute('aria-valuemax'));
  check('Program transport: clicking the seek bar jumps there', Math.abs(mid - lastF / 2) <= Math.max(2, lastF * 0.02), `${mid} of ${lastF}`);
  await pctl.getByRole('button', { name: 'Play or pause', exact: true }).click();
  await win.waitForTimeout(800);
  await pctl.getByRole('button', { name: 'Play or pause', exact: true }).click();
  check('Program transport: play advances, pause stops', (await ptc()) > mid, `${mid} → ${await ptc()}`);

  // ---------- a param drag takes the fast path (R-1, readiness audit) ----------
  at('param drag');
  const rng = win.locator('section[aria-label="Effects"] .param .rng[role=slider]').first();
  await rng.waitFor({ timeout: 10000 });
  const nodeHash = () => win.locator('section[aria-label="Context preview"] .frameview canvas').first().evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h;
  });
  /** Wait until the node preview shows a frame for which `ok(hash)` holds (a render lands asynchronously). */
  const settle = async (ok) => { let h; for (let i = 0; i < 60; i++) { h = await nodeHash(); if (ok(h)) return h; await win.waitForTimeout(150); } return h; };
  const v0 = Number(await rng.getAttribute('aria-valuenow'));
  const h0 = await nodeHash();
  await win.evaluate(() => { const c = window.__moshpitSyncCalls; c.updateProject = 0; c.setParam = 0; });
  await rng.scrollIntoViewIfNeeded(); // the Effects pane is short: scroll to the slider, as a user would
  const rb = await rng.boundingBox();
  await win.mouse.move(rb.x + rb.width * 0.1, rb.y + rb.height / 2);
  await win.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await win.mouse.move(rb.x + rb.width * (0.1 + 0.8 * (i / 40)), rb.y + rb.height / 2);
    if (i === 20) await win.waitForTimeout(1800); // Phase 0.2: a pause longer than the old 1.5 s window must not split the drag
  }
  await win.mouse.up();
  const calls = await win.evaluate(() => ({ ...window.__moshpitSyncCalls }));
  const v1 = Number(await rng.getAttribute('aria-valuenow'));
  check(`param drag: ${calls.setParam} one-param syncs, ${calls.updateProject} whole-project syncs`, calls.updateProject === 0 && calls.setParam >= 10, JSON.stringify(calls));
  // Settled, not just changed: a stream op (a look's Smear drives Hold) re-plans the stream, and the
  // first changed frame can be an intermediate one (measured: it settles within ~4 s, to exactly the
  // full update's pixels). Two equal reads 600 ms apart count as settled.
  const steady = async (ok) => { let a = await settle(ok); for (let i = 0; i < 40; i++) { await win.waitForTimeout(600); const b = await nodeHash(); if (b === a && ok(b)) return b; a = b; } return a; };
  const hFast = await steady((h) => h !== h0);
  check('param drag: the value lands and the node preview re-renders', v1 !== v0 && hFast !== h0, `${v0} → ${v1}`);
  // Redo resends the WHOLE project (the full path): the same value must render the same pixels.
  await win.keyboard.press('Control+z');
  const vUndo = Number(await rng.getAttribute('aria-valuenow'));
  const undid = await win.locator('.toasts .toast .tmsg', { hasText: /^Undid: / }).first().innerText({ timeout: 2000 }).catch(() => '');
  check('param drag with a 1.8 s pause: one undo restores the value (the drag is one step)', vUndo === v0, `${v1} → ${vUndo} (was ${v0})`);
  check('Ctrl+Z says what it undid', /^Undid: /.test(undid), undid || '(no toast)');
  await settle((h) => h !== hFast);
  await win.keyboard.press('Control+Shift+z');
  const hFull = await settle((h) => h === hFast);
  check('param drag: the fast path renders exactly what a full update renders', hFull === hFast && Number(await rng.getAttribute('aria-valuenow')) === v1, `${hFast} vs ${hFull}`);
  // Phase 0.5, precision input on the same param: click the value to type it, Esc cancels,
  // arrows step by the param's step, right-click resets to the default (v0: a fresh node's value).
  {
    const par = rng.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " param ")][1]');
    const lo = Number(await rng.getAttribute('aria-valuemin')), hi = Number(await rng.getAttribute('aria-valuemax'));
    const want = +(lo + (hi - lo) * 0.3713).toFixed(2);
    await par.locator('.pv').click();
    await par.locator('input.typein').fill(String(want));
    await par.locator('input.typein').press('Enter');
    const vTyped = Number(await rng.getAttribute('aria-valuenow'));
    await par.locator('.pv').click();
    await par.locator('input.typein').fill(String(lo));
    await par.locator('input.typein').press('Escape');
    const vEsc = Number(await rng.getAttribute('aria-valuenow'));
    await rng.focus();
    await win.keyboard.press('ArrowRight');
    const vArrow = Number(await rng.getAttribute('aria-valuenow'));
    await rng.click({ button: 'right' });
    const vReset = Number(await rng.getAttribute('aria-valuenow'));
    const shown = await par.locator('.pv').innerText();
    check('typed value is exact; Esc cancels; ←→ steps by 1/100 of the range; right-click resets', vTyped === want && vEsc === want && Math.abs(vArrow - (want + (hi - lo) / 100)) < 1e-6 && vReset === v0,
      `typed ${want} → ${vTyped} · esc ${vEsc} · arrow ${vArrow} · reset ${vReset} (default ${v0}) · shows "${shown}"`);
  }

  // ---------- freeze the motion block ----------
  at('freeze');
  // A freeze is a master render: time the masters' encode apart from the freeze itself.
  const mstT = await timed(() => win.locator('.statusstrip', { hasText: /FINALIZING/i }).waitFor({ state: 'detached', timeout: 10 * 60000 }));
  check(`full-quality masters finished (${mstT})`, true);
  const frzT = await timed(async () => {
    await win.locator('.blk.mot .frz').click();
    await win.locator('.blk.mot.frozen').waitFor({ timeout: 5 * 60000 });
  });
  check(`froze the motion block (${frzT})`, true);
  await shot('3-mosh-real');

  // ---------- export: H.264 + clip audio + mirror ----------
  at('export');
  await win.keyboard.press('Alt+3');
  await win.locator('.exprow button[aria-haspopup="menu"]').first().click();
  await win.keyboard.press('3'); // H.264
  const outDir = win.locator('.exprow .pathfld input').last();
  await outDir.fill(exports);
  await outDir.blur();
  const audioBtn = win.locator('.exprow .fld', { has: win.locator('label', { hasText: /^Audio$/ }) }).locator('button');
  if (!/clip audio/.test(await audioBtn.innerText())) await audioBtn.click();
  const mirrorBtn = win.locator('.exprow .fld', { hasText: 'Glitched audio' }).locator('button');
  if (!/glitched/.test(await mirrorBtn.innerText())) await mirrorBtn.click();
  // Render · add job starts rendering at once (it used to queue and wait for Run all).
  const expT = await timed(async () => {
    await win.getByRole('button', { name: /Render · add job/ }).click();
    await win.locator('.rtable tbody tr').first().waitFor();
    await win.locator('.rtable .st.done, .rtable .st.fail').first().waitFor({ timeout: 20 * 60000 });
  });
  const status = await win.locator('.rtable tbody tr').first().innerText();
  const log = await win.locator('.logbox').innerText().catch(() => '');
  check(`export finished (${expT})`, /done/.test(status), `${status.replace(/\s+/g, ' ')} | ${log.replace(/\s+/g, ' ')}`);
  const files = fs.existsSync(exports) ? fs.readdirSync(exports) : [];
  const mp4 = files.find((f) => f.endsWith('.mp4'));
  check('the output folder was created and holds the export', !!mp4, files.join(', '));
  if (mp4 && fs.existsSync(ffprobe)) {
    const streams = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'csv=p=0', path.join(exports, mp4)], { encoding: 'utf8' }).trim().split(/\r?\n/);
    check('export has H.264 video at the export size', streams.some((s) => /^h264,video,1920,1080/.test(s)), streams.join(' | '));
    check('export has an audio stream (clip audio + mirror)', streams.some((s) => /audio/.test(s)), streams.join(' | '));
  }
  await shot('4-render-real');

  // ---------- save → New → Open → save: identical ----------
  at('save / reopen');
  await win.keyboard.press('Control+s');
  await win.waitForFunction(() => !document.title.startsWith('•'), null, { timeout: 15000 });
  const saved = fs.readFileSync(projectFile, 'utf8');
  await win.keyboard.press('Control+n');
  await win.waitForFunction(() => document.title.startsWith('Untitled'), null, { timeout: 15000 });
  await win.keyboard.press('Control+o');
  await win.waitForFunction(() => document.title.includes('fullloop'), null, { timeout: 30000 });
  await win.keyboard.press('Control+s');
  await win.waitForTimeout(1000);
  const doc = JSON.parse(saved);
  // Both masters finished before the export, so the saved records are ready, at the presets picked.
  check('saved conforms are full quality, at the picked presets (Balanced + Fast)', doc.resources.conforms.every((c) => c.status !== 'proxy') && doc.resources.conforms.map((c) => c.quality).sort().join(',') === 'balanced,fast', JSON.stringify(doc.resources.conforms.map((c) => [c.status, c.quality])));
  check('saved project holds 2 sources, 2 conforms, 2 blocks, 1 freeze', doc.resources.sources.length === 2 && doc.resources.conforms.length === 2 && doc.timeline.blocks.length === 2 && doc.freezes.length === 1, JSON.stringify({ s: doc.resources.sources.length, c: doc.resources.conforms.length, b: doc.timeline.blocks.length, f: doc.freezes.length }));
  check('save → reopen → save is byte-identical on the real project', fs.readFileSync(projectFile, 'utf8') === saved);
  await win.keyboard.press('Alt+2');
  await win.locator('.blk').nth(1).waitFor({ timeout: 15000 });
  check('reopened: the frozen motion block is still frozen', (await win.locator('.blk.mot.frozen').count()) === 1);
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (e) {
  check('full loop ran to the end', false, `at "${step}": ${String(e).split('\n').slice(0, 14).join(' / ')}`);
  await shot('error').catch(() => {});
} finally {
  // The whole Electron tree (main + renderers + the render worker), then this process.
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `full loop: ${failed} FAILED (${lap()})` : `full loop: all ok (${lap()})`);
process.exit(failed ? 1 : 0);
