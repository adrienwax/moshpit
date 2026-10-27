// The light tour (3.2): the first-run offer, the steps in their own workspaces (Got it advances,
// Skip ends it, remembered across a reload), "?" replays; and the Starter Mosh builds a live sample
// project from three test clips (picture, motion with bypassed look, fresh picture).
// Run: node app/test/tour.e2e.mjs
import { launchApp } from './launch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.MOSHPIT_TEST_BACKGROUND ??= '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-tour');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const until = async (fn, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 150))) if (await fn()) return true; return false; };
// Bug hunt #9: the card must not sit over a control. Every visible button / input / select whose box
// meets the card's box, outside the card itself.
const covered = (win) => win.evaluate(() => {
  const c = document.querySelector('.tourcard')?.getBoundingClientRect();
  if (!c) return [];
  const meets = (r) => r.width > 0 && r.height > 0 && r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
  return [...document.querySelectorAll('button,input,select,textarea,[role=button],[role=slider]')]
    .filter((e) => !e.closest('.tourcard') && meets(e.getBoundingClientRect()))
    .map((e) => (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30));
});
const env = { MOSHPIT_LIBRARY: path.join(root, 'fixtures'), MOSHPIT_NO_CLOSE_PROMPT: '1', ...(process.env.MOSHPIT_TEST_CLIPS !== undefined ? { MOSHPIT_TEST_CLIPS: process.env.MOSHPIT_TEST_CLIPS } : {}) };

// ---------- the steps ----------
{
  const run = await launchApp({ root, userData: path.join(out, 'steps'), port: 9351, env });
  const win = run.win;
  const card = win.locator('.tourcard');
  const title = async () => ((await card.locator('b').textContent().catch(() => '')) ?? '').trim();
  try {
    await win.waitForSelector('.topbar', { timeout: 30000 });
    check('first run on Home: separate tour offer and durable Starter Mosh', await until(async () => (await win.locator('.tourcard.offer').count()) === 1) && await win.locator('.hstart .starter-mosh').count() === 1);
    check('…over no control on Home', await until(async () => (await covered(win)).length === 0, 3000), (await covered(win)).join(' | '));
    await win.screenshot({ path: path.join(out, 'offer.png') });
    await card.getByRole('button', { name: 'Show me around' }).click();
    check('the offer goes; Home has no step', await until(async () => (await card.count()) === 0));
    check('Starter Mosh stays available on Home after tour start', await win.locator('.hstart .starter-mosh').count() === 1);
    await win.keyboard.press('Alt+1');
    check('IN shows step 1', await until(async () => (await title()) === 'Pick and mark'), await title());
    check('Starter Mosh stays available in IN during the tour', await win.locator('.browse-clips .starter-mosh').count() === 1);
    check('…over no control in IN', await until(async () => (await covered(win)).length === 0, 3000), (await covered(win)).join(' | '));
    await card.getByRole('button', { name: 'Got it' }).click();
    check('Got it moves to step 2, in the same workspace', await until(async () => (await title()) === 'Send it to A or B'), await title());
    await card.getByRole('button', { name: 'Got it' }).click();
    check('…and IN is done', await until(async () => (await card.count()) === 0));
    await win.keyboard.press('Alt+2');
    check('MOSH shows step 3', await until(async () => (await title()) === 'Add a look'), await title());
    check('…over no control in MOSH', await until(async () => (await covered(win)).length === 0, 3000), (await covered(win)).join(' | '));
    await card.getByRole('button', { name: 'Skip the tour' }).click();
    check('Skip the tour ends it', await until(async () => (await card.count()) === 0));
    await win.waitForTimeout(1200); // settings are written 400 ms after the last change
    await win.reload();
    await win.waitForSelector('.topbar', { timeout: 30000 });
    await win.keyboard.press('Alt+2');
    await win.waitForTimeout(800);
    check('skipped stays skipped after a reload (no nagging)', (await card.count()) === 0);
    await win.locator('.topbar').getByRole('button', { name: 'Replay the tour' }).click();
    await win.keyboard.press('Alt+1');
    check('"?" replays it from step 1', await until(async () => (await title()) === 'Pick and mark'), await title());
    await win.screenshot({ path: path.join(out, 'step.png') });
    // Walk on to the last step (RENDER), checking each workspace's card on the way.
    const gotIt = async () => { const t = await title(); await card.getByRole('button', { name: 'Got it' }).click(); await until(async () => (await title()) !== t); };
    for (let i = 0; i < 2; i++) await gotIt(); // IN's two steps
    await win.keyboard.press('Alt+2');
    check('…over no control in MOSH (replayed)', await until(async () => (await title()) === 'Add a look') && (await covered(win)).length === 0, (await covered(win)).join(' | '));
    for (let i = 0; i < 3; i++) await gotIt();
    await win.keyboard.press('Alt+3');
    check('RENDER shows the last step, over no control', await until(async () => (await title()) === 'Render') && (await covered(win)).length === 0, (await covered(win)).join(' | '));
    await win.screenshot({ path: path.join(out, 'step-render.png') });
  } catch (e) {
    check('steps: ran to the end', false, String(e).split('\n')[0]);
  } finally {
    run.kill();
  }
}

// ---------- the Starter Mosh ----------
{
  const run = await launchApp({ root, userData: path.join(out, 'starter'), port: 9352, env });
  const win = run.win;
  try {
    await win.waitForSelector('.topbar', { timeout: 30000 });
    await win.locator('.tourcard.offer').getByRole('button', { name: "Skip, don't show again" }).click();
    await win.locator('.hstart .starter-mosh').click();
    const doc = () => win.evaluate(() => { const d = window.__moshpitState.doc(); return { name: d.name, sources: d.resources.sources.length, kinds: d.timeline.blocks.map((b) => b.kind), seconds: d.timeline.blocks.reduce((s, b) => s + (b.out - b.in) * b.repeat, 0) * d.settings.fps.den / d.settings.fps.num, look: d.timeline.blocks[1]?.graph.nodes.find((n) => n.kind === 'group.container') }; });
    check('the Starter Mosh builds: three distinct clips, picture / motion / fresh picture', await until(async () => { const d = await doc(); return d.name === 'Starter Mosh' && d.sources === 3 && d.kinds.join() === 'picture,motion,picture'; }, 180000), JSON.stringify(await doc()).slice(0, 160) + ' · toasts: ' + (await win.locator('.toasts .toast').allTextContents()).join(' | ').slice(0, 400));
    const d = await doc();
    check('the calm test footage creates a 25–35 second starter', d.seconds >= 25 && d.seconds <= 35, `${d.seconds}s; use MOSHPIT_TEST_CLIPS with the new 12-second set`);
    check('…with a starter look on the motion block, bypassed (switch it on to see the mosh)', d.look?.label === 'Melt' && d.look?.bypass === true, JSON.stringify(d.look && { label: d.look.label, bypass: d.look.bypass }));
    check('the arrangement names the look on block 2 (it said "no effects")', await until(async () => /Melt/.test((await win.locator('.tl .blk').nth(1).locator('.cnames').textContent().catch(() => '')) ?? '')), await win.locator('.tl .blk').nth(1).locator('.cnames').textContent().catch(() => '(none)'));
    check('…and it opens in MOSH', await until(async () => (await win.evaluate(() => window.__moshpitState.ui().ws)) === 'mosh'));
    await win.waitForTimeout(1500);
    await win.screenshot({ path: path.join(out, 'starter.png') });
  } catch (e) {
    check('starter: ran to the end', false, String(e).split('\n')[0]);
  } finally {
    run.kill();
  }
}
console.log(failed ? `tour: FAILED (${failed})` : 'tour: all ok');
process.exitCode = failed ? 1 : 0;
