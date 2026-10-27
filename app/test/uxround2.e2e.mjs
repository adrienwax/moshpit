// UX round 2, F2–F4 on the real app, in a profile seeded with a PRE-round-2 settings file
// (export codec HAP, no version), as Waxy's profile has:
//   F3 a new project exports H.264 (the old HAP default migrates once);
//   F2 the Render form's FPS is a picker, sized to its content, that sets the project rate;
//   F4 saving a layout again under its name replaces it (after a confirm), no "My layout 2".
//   node app/test/uxround2.e2e.mjs        (dev)   ·   MOSHPIT_EXE=<exe> node app/test/uxround2.e2e.mjs
import { _electron as electron, chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
process.env.MOSHPIT_CACHE_IN_PROFILE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-uxround2');
const ud = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(ud, 'config'), { recursive: true });
fs.writeFileSync(path.join(ud, 'config', 'settings.json'), JSON.stringify({ defaults: { codec: 'HAP', resolution: '1920×1080', fps: '24', proxyOnImport: true } }));

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };

let win, pid;
const env = { ...process.env, MOSHPIT_LIBRARY: path.join(root, 'fixtures') };
if (process.env.MOSHPIT_EXE) {
  const port = 9700 + Math.floor(Math.random() * 90);
  pid = spawn(process.env.MOSHPIT_EXE, [`--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], { env, stdio: 'ignore' }).pid;
  let browser;
  for (let i = 0; i < 400 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise((r) => setTimeout(r, 300)); } }
  // The packaged exe unpacks ~800 MB first: allow 120 s, and never leave an app running if attaching fails.
  if (!browser) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } throw new Error('could not attach to the app over CDP in 120 s'); }
  for (let i = 0; i < 100 && !win; i++) { win = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().includes('worker')); if (!win) await new Promise((r) => setTimeout(r, 200)); }
} else {
  const app = await electron.launch({ args: [path.join(root, 'app', 'dist', 'main.cjs'), `--user-data-dir=${ud}`], env });
  win = await app.firstWindow();
  pid = app.process().pid;
}
const errs = [];
/** Pick the radial sector whose label starts with `label` by its key (radials are flick-driven: a pointer move re-aims them). */
const pickSector = async (label) => {
  await win.locator('.rsect').first().waitFor({ timeout: 5000 });
  const key = await win.locator('.rsect').evaluateAll((g, l) => g.find((x) => (x.getAttribute('aria-label') ?? '').startsWith(l))?.querySelector('.rkey')?.textContent, label);
  await win.keyboard.press(key);
};
win.on('pageerror', (e) => errs.push(String(e)));

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  await win.keyboard.press('Control+n'); // a new project takes its export defaults from Settings
  await win.waitForFunction(() => document.title.startsWith('Untitled'), null, { timeout: 15000 });

  // F3
  await win.keyboard.press('Alt+3');
  const codec = (await win.locator('.exprow .fld', { has: win.locator('label', { hasText: /^Codec$/ }) }).innerText()).replace(/\s+/g, ' ');
  check('F3: a new project exports H.264 (an old saved HAP default migrated)', /H\.264/.test(codec) && !/HAP/.test(codec), codec);

  // F2
  const fpsFld = win.locator('.exprow .fld', { has: win.locator('label', { hasText: /^FPS$/ }) });
  const btn = fpsFld.locator('button');
  check('F2: the FPS field is a control, not read-only text', (await btn.count()) === 1 && (await fpsFld.locator('.ro').count()) === 0);
  const fw = (await fpsFld.boundingBox()).width, rw = (await win.locator('.exprow').first().boundingBox()).width;
  check('F2: …sized to its content, not the full form width', fw < rw / 2, `${Math.round(fw)} of ${Math.round(rw)} px`);
  const before = (await btn.innerText()).trim();
  await btn.click();
  await pickSector('25');
  const after = await win.waitForFunction((b) => { const f = [...document.querySelectorAll('.exprow .fld')].find((x) => x.querySelector('label')?.textContent === 'FPS'); const t = f?.querySelector('button')?.textContent?.trim(); return t && t !== b ? t : null; }, before, { timeout: 5000 }).then((h) => h.jsonValue(), () => before);
  check('F2: picking a rate sets the project rate', after !== before && /25/.test(after), `${before} → ${after}`);
  await btn.click();
  await pickSector('More');
  await pickSector('59.94');
  const high = await win.waitForFunction(() => { const f = [...document.querySelectorAll('.exprow .fld')].find((x) => x.querySelector('label')?.textContent === 'FPS'); const t = f?.querySelector('button')?.textContent?.trim(); return t && /59\.94/.test(t) ? t : null; }, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => 'not set');
  check('F2: the high rates sit under More (the radial holds six)', /59\.94/.test(high), high);

  // F4
  const menu = async () => { if (!(await win.locator('.lmenu.open').count())) await win.locator('.lmwrap > button.ghostbtn').click(); };
  await menu();
  await win.locator('.lmenu .lname').fill('wax1');
  await win.locator('.lmenu .row button.pri').click();
  await menu();
  const label = (await win.locator('.lmenu .row button.pri').innerText()).trim();
  check('F4: after saving, the box keeps the name and Save offers to save over it', (await win.locator('.lmenu .lname').inputValue()) === 'wax1' && /Save over "wax1"/.test(label), label);
  await win.locator('.lmenu .row button.pri').click();
  const confirm = win.locator('[role=alertdialog]', { hasText: 'Replace "wax1"?' });
  const asked = await confirm.waitFor({ timeout: 5000 }).then(() => true, () => false);
  if (asked) await confirm.getByRole('button', { name: 'Replace' }).click();
  await menu();
  const names = await win.locator('.lmenu .li .del').evaluateAll((els) => els.map((e) => e.parentElement.textContent.replace('✕', '').trim()));
  check('F4: saving again replaces "wax1" (with a confirm), no "My layout 2"', asked && names.length === 1 && /wax1/.test(names[0]) && !/My layout/.test(names[0]), names.join(' | '));
  // The transport's BPM is editable (the arrangement footer hides on a cramped lane, presentation pass).
  await win.keyboard.press('Alt+2');
  // Phase 0.5: the BPM is the shared number control: click to type, Enter sets it.
  const bf = win.locator('.composetop .bpmfield');
  await bf.click();
  await win.locator('.composetop input.bpmfield').fill('128');
  await win.locator('.composetop input.bpmfield').press('Enter');
  const footer = await win.locator('.tl .bpm .pval').innerText().catch(() => '');
  const shownBpm = await bf.innerText();
  check('the transport BPM field sets the project tempo', shownBpm === '128' && (footer === '' || /128/.test(footer)), `field ${shownBpm} · footer ${footer || '(no blocks)'}`);
  // The design system's faces really load (a CSP without font-src refused the bundled data: subsets).
  const faces = await win.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family); });
  check('Inter and JetBrains Mono are loaded (not a fallback face)', faces.some((f) => /Inter/.test(f)) && faces.some((f) => /JetBrains Mono/.test(f)), [...new Set(faces)].join(', '));
  // Phase 0.6, small states: in an empty project, every disabled control in every workspace says
  // why (a title, or the tooltip system's data-tip), and the empty panes are the designed ones.
  {
    const missing = [];
    for (const [key, ws] of [['Alt+0', 'home'], ['Alt+1', 'in'], ['Alt+2', 'mosh'], ['Alt+3', 'out']]) {
      await win.keyboard.press(key);
      await win.waitForTimeout(500);
      const bare = await win.evaluate(() => [...document.querySelectorAll('button:disabled, [aria-disabled="true"]')]
        .filter((b) => b.getClientRects().length && !(b.getAttribute('title') || b.getAttribute('data-tip')))
        .map((b) => (b.getAttribute('aria-label') || b.textContent || b.className).trim().slice(0, 30)));
      missing.push(...bare.map((b) => `${ws}: ${b}`));
    }
    check('every visible disabled control says why (title / tooltip)', missing.length === 0, missing.join(' | '));
    await win.keyboard.press('Alt+2');
    const clipsEmpty = await win.locator('section[aria-label="Clips"] .emptystate .es-t, .clips .emptystate .es-t').first().innerText().catch(() => '');
    const addFx = win.getByRole('button', { name: '＋ Add effect' });
    const fxStates = await addFx.evaluateAll((bs) => bs.map((b) => [b.disabled, b.getAttribute('title') || b.getAttribute('data-tip') || '']));
    check('empty MOSH: the clips pane says the project has none (not "no match"); every Add effect is off and says to select a block',
      /No clips in the project yet/.test(clipsEmpty) && fxStates.length >= 1 && fxStates.every(([d, t]) => d && /Select a block/.test(t)), `${clipsEmpty || '(no empty state)'} · ${JSON.stringify(fxStates)}`);
  }
  // Phase 0.4: a cache folder inside a media root is flagged (main then ignores it and uses the profile).
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.locator('.setnav').getByRole('button', { name: 'Folders & paths' }).click();
  const cacheIn = win.getByLabel('Cache / proxies', { exact: true });
  const mediaIn = win.getByLabel('Media root(s)', { exact: true });
  const mediaWas = await mediaIn.inputValue(), was = await cacheIn.inputValue();
  const mroot = path.join(out, 'media-root');
  fs.mkdirSync(mroot, { recursive: true });
  await mediaIn.fill(mroot);
  await cacheIn.fill(path.join(mroot, 'moshpit-cache'));
  const note = await win.locator('.pathnote.err').innerText({ timeout: 3000 }).catch(() => '');
  await cacheIn.fill(was);
  await mediaIn.fill(mediaWas);
  const gone = (await win.locator('.pathnote.err').count()) === 0;
  check('Settings flags a cache folder inside a media root, and clears when it moves out', /Overlaps the media root/.test(note) && gone, note || '(no note)');
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  check('ran to the end', false, String(e).split('\n').slice(0, 3).join(' / '));
} finally {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
}
console.log(failed ? `uxround2: ${failed} FAILED` : 'uxround2: all ok');
process.exit(failed ? 1 : 0);
