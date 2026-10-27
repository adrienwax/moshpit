// Path-to-Done P4: "feels like an app". Walks every workspace, pane and overlay and measures, in the
// live page: text contrast against its real background (WCAG ratio; flagged under 3:1, disabled
// controls excepted), font families (Inter / JetBrains Mono only), rounded corners left over from the
// prototype (the design is flat), and elements still coloured through a legacy name (--coral, --lav,
// --teal, --sky, --rose, --gold, --mint) that the HUD theme collapses onto one function colour.
// Screenshots per view in out/app-legibility/.  node app/test/legibility.e2e.mjs
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchApp } from './launch.mjs';

process.env.MOSHPIT_TEST_BACKGROUND = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'out', 'app-legibility');
const ud = path.join(out, 'userdata');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed++; };
const run = await launchApp({ root, userData: ud, port: 9345, env: { MOSHPIT_LIBRARY: path.join(root, 'fixtures') } });
const win = run.win;
const errs = [];
win.on('pageerror', (e) => errs.push(String(e)));

/** Measured in the page: the worst text contrasts, fonts in use, rounded boxes. */
const audit = () => win.evaluate(() => {
  // rgb()/rgba() are 0–255; color(srgb …) (what color-mix() computes to) is 0–1.
  const nums = (c) => { const n = (c.match(/[\d.]+/g) ?? []).map(Number); return c.startsWith('color(') ? [...n.slice(0, 3).map((v) => v * 255), ...n.slice(3)] : n; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      if (e.getBoundingClientRect().width < 4) continue; // a 1 px tick line is not what its label sits on
      const p = nums(getComputedStyle(e).backgroundColor);
      if (p.length >= 3 && (p.length < 4 || p[3] > 0.6)) return p.slice(0, 3);
    }
    return nums(getComputedStyle(document.body).backgroundColor).slice(0, 3);
  };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const dim = (el) => !!el.closest('[disabled],[aria-disabled="true"],.off,.unavailable,.disabled,.mkdim,.react-flow__attribution');
  const low = [], fonts = {}, round = [], legacy = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const s = getComputedStyle(el);
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) {
      const f = s.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      fonts[f] = (fonts[f] ?? 0) + 1;
      if (!dim(el)) {
        const fg = nums(s.color), bg = bgOf(el);
        const a = fg.length > 3 ? fg[3] : 1;
        const mixed = fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
        const lf = L(mixed), lb = L(bg);
        const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
        if (ratio < 3) { const rc = el.getBoundingClientRect(); low.push({ ratio: +ratio.toFixed(2), text: el.textContent.trim().slice(0, 30), cls: (el.className?.baseVal ?? el.className ?? '').toString().slice(0, 40) || el.parentElement?.className?.toString().slice(0, 40), size: s.fontSize, fg: s.color, bg: bgOf(el).join(','), at: [Math.round(rc.x), Math.round(rc.y), Math.round(rc.width), Math.round(rc.height)] }); }
      }
    }
    const rr = parseFloat(s.borderTopLeftRadius);
    const r = el.getBoundingClientRect();
    // Flat design: a radius over 3 px on anything bigger than a dot / socket / pill handle.
    if (rr > 3 && rr < Math.min(r.width, r.height) / 2 - 1 && r.width > 14 && r.height > 14 && !el.closest('.react-flow__minimap,.rgauge-row,svg')) round.push(`${(el.className?.baseVal ?? el.className ?? el.tagName).toString().split(' ')[0]}:${rr}px`);
    const st = el.getAttribute('style') ?? '';
    if (/var\(--(coral|lav|teal|sky|rose|gold|mint)\)/.test(st)) legacy.push((el.className?.baseVal ?? el.className ?? el.tagName).toString().split(' ')[0]);
  }
  const uniq = (a) => [...new Set(a)];
  return { low: low.sort((x, y) => x.ratio - y.ratio).slice(0, 8), lowCount: low.length, fonts, round: uniq(round).slice(0, 12), roundCount: round.length, legacy: uniq(legacy).slice(0, 12), legacyCount: legacy.length };
});

const results = {};
const view = async (name, go) => {
  try { await go(); } catch (e) { check(`${name}: reached`, false, String(e).split('\n')[0]); return; }
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(out, `${name}.png`) });
  const r = await audit();
  results[name] = r;
  const fonts = Object.keys(r.fonts);
  const okFonts = fonts.every((f) => /^(Inter|JetBrains Mono)/.test(f));
  console.log(`info ${name}: low-contrast ${r.lowCount}, rounded ${r.roundCount}, legacy-colour ${r.legacyCount}, fonts ${fonts.join(' / ')}`);
  if (r.lowCount) console.log(`     worst: ${r.low.map((x) => `${x.ratio}:${x.cls || '?'}:"${x.text}" fg ${x.fg} bg ${x.bg} @${x.at}`).join(' | ')}`);
  if (r.roundCount) console.log(`     rounded: ${r.round.join(' ')}`);
  if (r.legacyCount) console.log(`     legacy: ${r.legacy.join(' ')}`);
  check(`${name}: only Inter / JetBrains Mono`, okFonts, fonts.join(' / '));
  check(`${name}: no text under 3:1 contrast`, r.lowCount === 0);
  check(`${name}: flat (no prototype rounding)`, r.roundCount === 0);
};

try {
  await win.waitForSelector('.topbar', { timeout: 30000 });
  if (!run.packaged) await win.setViewportSize({ width: 1920, height: 1080 });
  await win.evaluate(() => document.fonts.ready);
  await view('01-home', async () => win.locator('.ws-home').waitFor());
  await view('02-in', async () => { await win.keyboard.press('Alt+1'); await win.locator('.gcell', { hasText: 'src-a.mp4' }).click({ timeout: 60000 }); await win.waitForTimeout(800); });
  await view('03-in-sent', async () => {
    await win.locator('.convbar').getByRole('button', { name: 'Select entire clip' }).click();
    await win.locator('.convbar').getByRole('button', { name: /^Send to A/ }).click();
    const ask = win.locator('[role=alertdialog]', { hasText: 'Match the project' });
    if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.getByRole('button', { name: /^Use / }).click();
    await win.locator('.convbar .hdnote').waitFor({ timeout: 120000 });
  });
  await view('04-mosh', async () => { await win.keyboard.press('Alt+2'); await win.locator('.loupe[data-loupe="A"] .ztools .tbtn.pop').click(); await win.locator('.tl .blk').first().click(); });
  await view('05-effect-browser', async () => { await win.getByRole('button', { name: '＋ Add effect' }).first().click(); await win.locator('aside.fxbrowser .op').first().waitFor(); await win.waitForTimeout(1500); });
  await view('06-audition', async () => { await win.locator('aside.fxbrowser .op', { has: win.locator('.nm', { hasText: /^Posterize/ }) }).first().click(); await win.locator('.auditionbar').waitFor(); await win.waitForTimeout(1200); });
  await view('07-graph', async () => { await win.keyboard.press('Escape'); await win.keyboard.press('Alt+g'); await win.locator('.ws-node .react-flow__node-mp').first().waitFor(); });
  // No cyan collapse: the graph's node categories are told apart by colour (Clip, Decode, Output at least).
  const cats = await win.locator('.ws-node .react-flow__node-mp .cattag').evaluateAll((els) => els.map((e) => `${e.textContent}=${getComputedStyle(e).color}`));
  const colours = new Set(cats.map((c) => c.split('=')[1]));
  check('graph: node categories keep distinct colours', colours.size >= 3 && colours.size === new Set(cats.map((c) => c.split('=')[0])).size, cats.join(' | '));
  await view('08-radial', async () => { const f = await win.locator('.canvaswrap .react-flow').boundingBox(); await win.mouse.dblclick(f.x + 60, f.y + f.height - 60); await win.locator('.radial2').waitFor(); });
  await view('09-out', async () => { await win.keyboard.press('Escape'); await win.keyboard.press('Alt+3'); await win.locator('.exprow').waitFor(); });
  await view('10-settings', async () => { await win.locator('.topbar .cog').click(); await win.waitForTimeout(400); });
  await view('11-history', async () => { await win.keyboard.press('Alt+2'); await win.getByRole('button', { name: 'History' }).first().click(); await win.waitForTimeout(300); });
  check('no page errors', !errs.length, errs[0] ?? '');
} catch (e) {
  check('ran to the end', false, String(e).split('\n')[0]);
} finally {
  fs.writeFileSync(path.join(out, 'legibility.json'), JSON.stringify(results, null, 2));
  run.kill();
}
console.log(failed ? `legibility: FAILED (${failed})` : 'legibility: all ok');
process.exitCode = failed ? 1 : 0;
