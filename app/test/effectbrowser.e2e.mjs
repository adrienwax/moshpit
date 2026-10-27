// Phase 2: the effect browser. 2.1: browse by look two levels deep, search the explanations, filter
// by family, read the five-part explanation, add an effect, a recipe and a utility node, each one
// undo step. 2.2: selecting auditions it on the Program without changing the project; Shift-click
// shortlists; ▶ 2 s loops; Apply commits one step; closing ends it. 2.3: each effect drawn on the
// block (posters in view, the hovered one moving), a saved toggle. 2.5: intent search. 2.6: hold
// Original / the \ key, the wipe, favourites and tags. Screenshots in out/app-effectbrowser/.
//   node app/test/effectbrowser.e2e.mjs        (dev build: node app/build.mjs first)
import { launchApp, treeMemMB } from './launch.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
process.env.MOSHPIT_CACHE_IN_PROFILE = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-effectbrowser');
const ud = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const run = await launchApp({ root, userData: ud, port: 9343, env: { MOSHPIT_LIBRARY: path.join(root, 'fixtures') } });
const win = run.win;
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));
await win.setViewportSize({ width: 1600, height: 1000 });
const shot = (n) => win.screenshot({ path: path.join(out, `${n}.png`) });
const panel = win.locator('aside.fxbrowser');
const detail = panel.locator('section.fxgallery-detail');
const row = (t) => panel.locator('.op', { has: win.locator('.nm', { hasText: new RegExp(`^\\W*${t}`) }) }).first();
const toastHas = (re) => win.locator('.toasts .toast', { hasText: re }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
const nodeCount = () => win.evaluate(() => window.__moshpitDoc?.().timeline.blocks[0].graph.nodes.length ?? -1);

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  await win.keyboard.press('Alt+1');
  await win.locator('.gcell', { hasText: 'src-b.mp4' }).click({ timeout: 60000 });
  await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
  await win.locator('.convbar').getByRole('button', { name: /Add block/ }).click();
  const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
  if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
  await win.locator('.toasts .toast', { hasText: /Added \d+ f of src-b\.mp4/ }).first().waitFor({ timeout: 180000 });
  await win.keyboard.press('Alt+2');
  await win.locator('.tl .blk').first().click();
  await win.getByRole('button', { name: '＋ Add effect' }).first().click();
  await panel.locator('.op').first().waitFor({ timeout: 5000 });

  // ---------- 2.1 browse ----------
  const tabs = await panel.locator('.fxtabs [role=tab]').allInnerTexts();
  check('tabs: All, Favourites, the seven categories, Looks', tabs.length === 10 && tabs[0] === 'All' && tabs[1] === '★ Favourites' && tabs.at(-1) === 'Looks', tabs.join(' | '));
  await shot('01-browser-all');
  await panel.getByRole('tab', { name: 'Melt & Smear' }).click();
  const heads = await panel.locator('.fxgroup').allInnerTexts();
  check('a look opens its subcategories and its recipes', ['motion bleed', 'bloom', 'liquefy', 'looks'].every((h) => heads.some((x) => x.toLowerCase().includes(h))), heads.map((h) => h.replace(/\s+/g, ' ')).join(' | '));
  await shot('02-melt-and-smear');

  // ---------- 2.3 live previews ----------
  await panel.getByRole('tab', { name: 'Colour & Split' }).click();
  const nodes0 = await win.locator('.ws-mosh .react-flow__node-mp').count();
  const ready = () => panel.locator('.fxthumb').evaluateAll((els) => els.filter((e) => !e.querySelector('.prep') && e.querySelector('canvas')?.width > 1).length);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && (await ready()) < 4) await win.waitForTimeout(250);
  const drawn = await ready(), total = await panel.locator('.fxthumb').count();
  check('each effect is drawn on the block (posters)', drawn >= 4, `${drawn} of ${total} drawn in ${Date.now() - t0} ms`);
  // Larger gallery cards are lazy-rendered: bring each requested poster into view first.
  const px = async (t) => {
    const thumb = row(t).locator('.fxthumb');
    await thumb.scrollIntoViewIfNeeded();
    await thumb.locator('canvas').waitFor();
    await thumb.locator('.prep').waitFor({ state: 'detached', timeout: 20000 });
    return thumb.locator('canvas').evaluate((c) => c.toDataURL().slice(-120));
  };
  check('two effects look different', (await px('Invert')) !== (await px('Sepia')) && !!(await px('Invert')));
  await shot('08-previews');
  const still = await px('Invert');
  await row('Invert').locator('.fxthumb').hover();
  await win.waitForTimeout(1200);
  check('hovering moves that preview (the only moving one)', (await panel.locator('.fxthumb.moving').count()) === 1 && (await px('Invert')) !== still);
  await win.mouse.move(5, 5);
  check('previews changed nothing in the project', (await win.locator('.ws-mosh .react-flow__node-mp').count()) === nodes0);
  await panel.locator('.thumbtoggle').click();
  check('the toggle turns previews off', (await panel.locator('.fxthumb').count()) === 0);
  await win.waitForTimeout(700);
  const saved = JSON.parse(fs.readFileSync(path.join(ud, 'config', 'settings.json'), 'utf8'));
  check('and is saved with the settings', saved.liveThumbs === false, String(saved.liveThumbs));
  await panel.locator('.thumbtoggle').click();
  check('and back on', (await panel.locator('.fxthumb').count()) > 0);
  // Memory under the previews: every tab, five rounds. Rounds 2–5 show the same thumbnails, so a
  // leak (an unclosed ImageBitmap, a trial slot per graph) shows as steady growth across them.
  const mem = async () => treeMemMB(run.pid);
  const rounds = [];
  for (let k = 0; k < 5; k++) {
    for (const t of await panel.locator('.fxtabs [role=tab]').allInnerTexts()) { await panel.getByRole('tab', { name: t, exact: true }).click(); await win.waitForTimeout(600); }
    rounds.push(Math.round(await mem()));
  }
  // Steady = round 5 within 96 MB of round 2 (one round swings ±64 MB with GC and the scrub cache).
  check('memory steady across preview rounds', rounds[4] - rounds[1] < 96, `${rounds.join(' → ')} MB working set`);
  await panel.getByRole('tab', { name: 'Colour & Split' }).click();

  await panel.getByRole('tab', { name: 'All' }).click();
  await panel.getByLabel('Search effects').fill('tape colour');
  const found = await panel.locator('.op .nm').allInnerTexts();
  check('search reads the explanations ("tape colour")', found.some((t) => t.startsWith('Chroma drift')), found.join(' | '));
  // 2.5: intent, not names
  await panel.getByLabel('Search effects').fill('glitchy melting rainbow smear');
  await win.waitForTimeout(300);
  const head = (await panel.locator('.fxgroup').first().innerText()).toLowerCase();
  const ranked = await panel.locator('.op .nm').allInnerTexts();
  check('an intent search ranks one list of best matches', head.startsWith('best matches') && ranked.length >= 5, `${head} · ${ranked.slice(0, 5).map((t) => t.split(/\n/)[0]).join(', ')}`);
  check('each match says which look it belongs to', (await panel.locator('.op .lk').count()) === ranked.length);
  await panel.getByLabel('Search effects').fill('pixelated');
  await win.waitForTimeout(300);
  check('"pixelated" puts Resolution crush first', (await panel.locator('.op .nm').first().innerText()).startsWith('Resolution crush'));
  await shot('09-intent-search');
  await panel.getByLabel('Search effects').fill('tape colour');
  await row('Chroma drift').click();
  await panel.getByRole('region', { name: 'Tune Chroma drift', exact: true }).waitFor();
  await detail.locator('.fxguidance > summary').click();
  const dts = await detail.locator('.explain dt').allInnerTexts();
  check('selecting shows Use when / Works best with / Watch out / Try next', dts.join('|').toLowerCase() === 'use when|works best with|watch out|try next', dts.join('|'));
  await shot('03-search-explained');
  const link = detail.locator('.trylink').first();
  const linkText = (await link.innerText().catch(() => '')).replace('→ ', '');
  await link.click();
  check('a Try next link selects that effect', (await panel.locator('.op.sel .nm').innerText().catch(() => '')).startsWith(linkText), linkText);

  await panel.getByLabel('Search effects').fill('');
  await row('Chroma drift').click();
  const n0 = await win.locator('.ws-mosh .react-flow__node-mp').count();
  await detail.locator('.opacts .add').click();
  check('Add puts the effect on the block (toast)', await toastHas(/Added Chroma drift to Block 1/));
  await win.waitForTimeout(400);
  check('the graph grew by one node', (await win.locator('.ws-mosh .react-flow__node-mp').count()) === n0 + 1, `${n0} → ${await win.locator('.ws-mosh .react-flow__node-mp').count()}`);

  await panel.getByRole('tab', { name: 'Looks', exact: true }).click();
  await row('VHS Decay').click();
  await detail.locator('.opacts .add').click();
  check('a recipe applies as one step', await toastHas(/Applied VHS Decay to Block 1/));

  // ---------- 2.2 audition ----------
  const prog = win.locator('section[aria-label="Program"]');
  const progLabel = () => prog.locator('.pvcard').innerText().then((t) => t.replace(/\s+/g, ' '), () => '');
  const progPixels = () => prog.locator('canvas').first().evaluate((c) => c.toDataURL().slice(-200));
  const graphNodes = () => win.locator('.ws-mosh .react-flow__node-mp').count();
  await panel.getByRole('tab', { name: 'All' }).click();
  await win.waitForTimeout(800);
  const before = { nodes: await graphNodes(), pixels: await progPixels(), steps: await win.evaluate(() => document.querySelectorAll('.hitem').length) };
  await row('Invert').click();
  await prog.locator('.auditionbar').waitFor({ timeout: 5000 });
  const ta = Date.now();
  while (Date.now() - ta < 8000 && (await progPixels()) === before.pixels) await win.waitForTimeout(100);
  const auditionMs = Date.now() - ta;
  check('selecting auditions it on the Program, labelled not applied', (await progLabel()).includes('AUDITION · Invert · not applied'), (await progLabel()).slice(0, 90));
  check('the auditioned picture differs from the program', (await progPixels()) !== before.pixels, `after ${auditionMs} ms`);
  console.log(`info audition on the Program after ${auditionMs} ms (previews on)`);
  check('auditioning added nothing to the graph', (await graphNodes()) === before.nodes, `${before.nodes} → ${await graphNodes()}`);
  await shot('05-audition');
  // 2.6 before / after: hold Original → the project's picture; Wipe → both, split
  const orig = prog.getByRole('button', { name: '◐ Original' });
  const ob = (await orig.boundingBox());
  await win.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await win.mouse.down();
  await win.waitForTimeout(700);
  const held = await progLabel();
  const heldPx = await progPixels();
  await win.mouse.up();
  check('holding Original shows the project as it is', held.includes('ORIGINAL') && heldPx === before.pixels, held.slice(0, 60));
  await win.keyboard.down('Backslash');
  await win.waitForTimeout(500);
  check('the backslash key held does the same', (await progLabel()).includes('ORIGINAL'));
  await win.keyboard.up('Backslash');
  await prog.getByRole('button', { name: '⇹ Wipe' }).click();
  await win.waitForTimeout(1200);
  check('Wipe shows the original and the audition, split', (await prog.locator('.wipe canvas').count()) === 2 && (await prog.getByRole('slider', { name: /Wipe/ }).count()) === 1);
  await shot('10-wipe');
  // While auditioning, the fill for the audition yields to the previews (it used to starve them ~3 s).
  const tp = Date.now();
  while (Date.now() - tp < 2000 && (await ready()) < 4) await win.waitForTimeout(100);
  check('previews still draw during an audition', (await ready()) >= 4, `${await ready()} drawn after ${Date.now() - tp} ms`);
  await prog.getByRole('button', { name: '⇹ Wipe' }).click();
  await row('Posterize').click({ modifiers: ['Shift'] });
  await row('Saturation').click({ modifiers: ['Shift'] });
  const chips = await prog.locator('.shortlist .chip').allInnerTexts();
  check('Shift-click shortlists without switching the audition', chips.length === 2 && (await progLabel()).includes('Invert'), chips.join(' | '));
  await prog.locator('.shortlist .chip', { hasText: 'Posterize' }).locator('button').first().click();
  for (let k = 0; k < 40 && !(await progLabel()).includes('AUDITION · Posterize'); k++) await win.waitForTimeout(100);
  check('a shortlist chip auditions that candidate', (await progLabel()).includes('AUDITION · Posterize'), (await progLabel()).slice(0, 60));
  await prog.getByRole('button', { name: '▶ 2 s' }).click();
  await win.waitForTimeout(2600);
  check('▶ 2 s loops while auditioning', await prog.getByRole('button', { name: '◼ stop' }).isVisible());
  await prog.getByRole('button', { name: '◼ stop' }).click();
  await shot('06-shortlist');
  await prog.getByRole('button', { name: 'Apply' }).click();
  check('Apply adds the auditioned effect as one step', await toastHas(/Added Posterize to Block 1/));
  await win.waitForTimeout(400);
  check('the audition ends on Apply and the graph has it', !(await prog.locator('.auditionbar').count()) && (await graphNodes()) === before.nodes + 1, `${before.nodes} → ${await graphNodes()}`);
  // A bitstream op changes the stream plan (stage 1), not just the GPU graph: it auditions too.
  await row('Reverse').click();
  await prog.locator('.auditionbar').waitFor({ timeout: 5000 });
  await win.waitForTimeout(2500);
  const rev = await progLabel();
  check('a bitstream op (Reverse) auditions, with no error', rev.includes('AUDITION · Reverse') && !(await prog.locator('.frameerr, .err').count()), rev.slice(0, 90));
  await shot('07-audition-bitstream');
  await row('Sepia').click();
  await prog.locator('.auditionbar').waitFor({ timeout: 5000 });
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  check('closing the browser ends the audition, nothing added', !(await prog.locator('.auditionbar').count()) && (await graphNodes()) === before.nodes + 1);
  await win.getByRole('button', { name: '＋ Add effect' }).first().click();
  await panel.locator('.op').first().waitFor({ timeout: 5000 });

  await panel.getByRole('tab', { name: 'All' }).click();
  await panel.locator('.fxgallery-filters > summary').click();
  await panel.locator('.fxgallery-filters .fxfacets button', { hasText: 'Tone' }).click();
  const tone = await panel.locator('.op .nm').allInnerTexts();
  check('the Tone facet shows the 7 tone effects', new Set(tone).size === 7, `${new Set(tone).size}: ${[...new Set(tone)].join(', ')}`);
  await panel.locator('.fxgallery-filters .fxfacets button', { hasText: 'clear' }).click();
  await panel.locator('.fxgallery-filters > summary').click();

  // 2.6 favourites and tags
  await panel.getByRole('tab', { name: 'All' }).click();
  await row('Invert').locator('.fav').click();
  await row('Hold').locator('.fav').click();
  await panel.getByRole('tab', { name: '★ Favourites' }).click();
  const favRows = [...new Set((await panel.locator('.op .nm').allInnerTexts()).map((t) => t.split(String.fromCharCode(10))[0].replace(/[♥♡]/g, '').trim()))];
  check('♡ adds to the Favourites tab (each once)', favRows.length === 2 && favRows.some((t) => t.startsWith('Invert')) && favRows.some((t) => t.startsWith('Hold')), favRows.join(' | '));
  await row('Invert').click();
  await panel.getByLabel('Add a tag').fill('strobe');
  await panel.getByLabel('Add a tag').press('Enter');
  await win.waitForTimeout(700);
  const st = JSON.parse(fs.readFileSync(path.join(ud, 'config', 'settings.json'), 'utf8'));
  check('favourites and tags are saved with the settings', st.effectFavs?.includes('fx.invert') && st.effectFavs?.includes('mosh.hold') && st.effectTags?.['fx.invert']?.includes('strobe'), JSON.stringify({ f: st.effectFavs, t: st.effectTags }));
  await panel.getByRole('tab', { name: 'All' }).click();
  await panel.locator('.usertags button', { hasText: '#strobe' }).click();
  const tagged = [...new Set((await panel.locator('.op .nm').allInnerTexts()).map((t) => t.split(String.fromCharCode(10))[0]))];
  check('a tag is a filter chip', tagged.length === 1 && tagged[0].startsWith('Invert'), tagged.join(' | '));
  await panel.locator('.usertags button', { hasText: 'clear' }).click();
  await panel.getByLabel('Search effects').fill('strobe');
  await win.waitForTimeout(300);
  check('and a word the search finds', (await panel.locator('.op .nm').first().innerText()).startsWith('Invert'));
  await shot('11-favourites-tags');
  await panel.getByLabel('Search effects').fill('');

  await panel.getByRole('tab', { name: 'Utility' }).click();
  await row('Mix').click();
  await detail.locator('.opacts .add').click();
  check('a utility node is placed in the graph, unwired', await toastHas(/Placed Mix in Block 1's graph/));
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+z');
  check('one undo removes it', await toastHas(/Undid: /));
  await shot('04-after');
} catch (e) {
  check('run', false, String(e).split('\n')[0]);
  await shot('error').catch(() => {});
}
check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
run.kill();
console.log(failed ? `effectbrowser: FAILED (${failed})` : 'effectbrowser: all ok');
process.exitCode = failed ? 1 : 0;
