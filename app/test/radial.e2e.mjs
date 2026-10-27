// Radial + QoL interaction check, real mouse and keyboard in headless Chrome against the dev
// server (mock engine). Run `npm run web -w app` first, then: node app/test/radial.e2e.mjs
import { chromium } from 'playwright';

const URL = process.env.MOSHPIT_URL ?? 'http://localhost:5174/';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failed++;
};
const slices = () => p.$$eval('.rsect', (gs) => gs.map((g) => g.getAttribute('aria-label') + (g.classList.contains('off') ? ' [off]' : '')));
const nodes = () => p.$$eval('.react-flow__node-mp', (n) => n.length);
const edges = () => p.$$eval('.react-flow__edge', (n) => n.length);
const wait = (ms) => p.waitForTimeout(ms);

await p.goto(URL);
await p.evaluate(() => localStorage.clear());
await p.reload();
await p.waitForSelector('.topbar');
await p.keyboard.press('Alt+g');
await p.waitForSelector('.react-flow__node-mp');
await wait(900); // fit animation
const flow = await p.$eval('.canvaswrap .react-flow', (el) => el.getBoundingClientRect().toJSON());
const empty = { x: flow.left + 60, y: flow.bottom - 60 };

// 1. double-click empty canvas → root ring (Phase 2.1a: Add by look, Utility, Search, View, Layout, Recipes)
await p.mouse.dblclick(empty.x, empty.y);
await wait(200);
let s = await slices();
check('root ring: Add N · Utility NE · Search SE · View S · Layout SW · Recipes NW', s.join('|') === 'Add (opens more) — N|Utility (opens more) — NE|Search (opens more) — SE|View (opens more) — S|Layout (opens more) — SW|Recipes (opens more) — NW', s.join('|'));

// 2. 1 → the six looks, the browser's taxonomy
const n0 = await nodes();
await p.keyboard.press('1');
s = await slices();
const LOOKS = ['Melt & Smear', 'Fracture & Displace', 'Stutter & Repeat', 'Decay & Corrupt', 'Echo & Trail', 'Colour & Split'];
check('Add ring: the six looks clockwise from N', s.length === 6 && LOOKS.every((l, i) => s[i].startsWith(l)), s.join('|'));

// 3. Backspace goes back, and never reaches React Flow's delete
await p.keyboard.press('Backspace');
s = await slices();
check('Backspace → back to root', s.length === 6 && s[0].startsWith('Add'), s.join('|'));
check('Backspace inside the menu deleted nothing', (await nodes()) === n0);

// 4. Add → Colour & Split → its subcategories → Chroma shift → type → Enter adds a node
await p.keyboard.press('1');
await p.keyboard.press('6');
s = await slices();
// Its three kinds in order, its recipes if it has any (Chroma Ghost), and Back.
const kindsIn = s.filter((x) => !/^(Back|Recipes)/.test(x)).map((x) => x.split(' (')[0].split(' —')[0]);
check('a look opens its subcategories in order, with Back', kindsIn.join('|') === 'Channel split|Chroma shift|Tone & grade' && s.some((x) => x.startsWith('Back')), s.join('|'));
await p.keyboard.press(String(s.findIndex((x) => x.startsWith('Chroma shift')) + 1));
await p.waitForSelector('.rsearch input');
await p.keyboard.type('chro');
const listed = await p.$$eval('.rsitem', (r) => r.length);
await p.keyboard.press('Enter');
await wait(200);
check('Chroma shift list filters, Enter adds a node', listed > 0 && (await nodes()) === n0 + 1, `listed ${listed}, nodes ${await nodes()}`);

// 4b. Tab at the centre: search every node, type, Enter
await p.mouse.dblclick(empty.x - 40, empty.y - 40);
await wait(200);
await p.keyboard.press('Tab');
await p.waitForSelector('.rsearch input');
await p.keyboard.type('posteri');
await p.keyboard.press('Enter');
await wait(200);
check('Tab opens the search at the centre; Enter adds', (await nodes()) === n0 + 2, `nodes ${await nodes()}`);

// 4c. a look's recipes, applied to the block as one step
await p.mouse.dblclick(empty.x + 420, empty.y - 10); // clear canvas: 4 and 4b placed nodes at the points before
await wait(200);
await p.keyboard.press('1');
await p.keyboard.press('1'); // Melt & Smear
s = await slices();
check('Melt & Smear offers its recipes', s.some((x) => x.startsWith('Recipes')), s.join('|'));
await p.keyboard.press(String(s.findIndex((x) => x.startsWith('Recipes')) + 1));
await p.waitForSelector('.rsearch input');
await p.keyboard.type('dream');
await p.keyboard.press('Enter');
await wait(250);
check('a look from the radial places it as one container (Dream Melt)', (await nodes()) === n0 + 3 && (await p.$$eval('.react-flow__node .gnode.container', (n) => n.length)) === 1, `nodes ${await nodes()}`);

// 5. dead-zone click goes back / closes
await p.mouse.dblclick(empty.x, empty.y);
await wait(250);
const ring = await p.$eval('.radial2', (el) => el.getBoundingClientRect().toJSON());
await p.mouse.click(ring.left + ring.width / 2 + 5, ring.top + ring.height / 2 + 5);
await wait(100);
check('centre dead-zone click closes the root ring without firing', !(await p.$('.radialoverlay')) && (await nodes()) === n0 + 3);

// 6. hold A, flick north, release → the looks
await p.mouse.move(empty.x, empty.y);
await p.keyboard.down('a');
await wait(50);
await p.mouse.move(empty.x, empty.y - 90, { steps: 4 });
await wait(250);
await p.keyboard.up('a');
await wait(100);
s = await slices();
check('hold-A flick north + release opens the looks', s.length === 6 && /Melt/.test(s[0]), s.join('|'));
await p.keyboard.press('Escape');

// 7. wire dropped on empty canvas → By look / Utility / Search, filtered to what accepts the wire
// Fit first: the nodes added above sit near the canvas bottom, where React Flow auto-pans a drag.
await p.locator('.ws-node').getByRole('button', { name: /fit/ }).first().click().catch(() => {});
await wait(400);
const src = await p.evaluate(() => {
  const n = [...document.querySelectorAll('.react-flow__node-mp')].find((x) => x.textContent.includes('Chroma'));
  const r = n.querySelector('.react-flow__handle-right').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const e0 = await edges();
await p.mouse.move(src.x, src.y);
await p.mouse.down();
await p.mouse.move(empty.x + 300, empty.y, { steps: 8 });
await p.mouse.up();
await wait(250);
s = await slices();
const title = await p.$eval('.rtitle', (t) => t.textContent).catch(() => '');
check('socket drop opens "Add · image in"', /image in/.test(title), title);
check('socket ring: By look N · Utility E · Back S · Search W', /^By look.*— N$/.test(s[0]) && /^Utility.*— E$/.test(s[1]) && /^Back/.test(s[2]) && /^Search.*— W$/.test(s[3]), s.join('|'));
await p.keyboard.press('1');
await p.keyboard.press('3'); // Stutter & Repeat
s = await slices();
// Off a picture wire, the bitstream-only kinds are off; Time fracture keeps Field desync (a picture op).
check('off an image wire, bitstream-only subcategories are off', /^Frame repeat.* \[off\]$/.test(s[0]) && /^Freeze & hold.* \[off\]$/.test(s[1]) && !/\[off\]/.test(s.find((x) => x.startsWith('Time fracture')) ?? '[off]'), s.join('|'));
await p.keyboard.press('1');
await wait(250);
check('picking a disabled subcategory adds nothing', (await edges()) === e0, `edges ${e0} → ${await edges()}`);
await p.keyboard.press('Escape');
await wait(150);

// 8. codec picker: 2 levels, Back at S in the sub-ring
await p.keyboard.press('Alt+3');
await p.waitForSelector('button[aria-haspopup="menu"]');
await p.click('.exprow button[aria-haspopup="menu"] >> nth=0');
await wait(200);
s = await slices();
check('codec picker root: HAP › · ProRes › · H.264 · PNG', s.length === 4 && /HAP \(opens more\)/.test(s[0]), s.join('|'));
await p.keyboard.press('1');
s = await slices();
check('HAP sub-ring has Back at S', s.length === 4 && /^Back.*— S$/.test(s[2]), s.join('|'));
await p.keyboard.press('2');
await wait(100);
const codec = await p.$eval('.exprow button[aria-haspopup="menu"] >> nth=0', (b) => b.textContent);
check('choosing HAP Q updates the field', /HAP Q/.test(codec), codec);

// 9. snap picker from the keyboard opens on the button
await p.keyboard.press('Alt+2');
await p.waitForSelector('.snappick');
await p.focus('.snappick');
await p.keyboard.press('Enter');
await wait(150);
s = await slices();
await p.keyboard.press('2');
await wait(100);
check('snap picker (keyboard): frame/beat/bar, 2 → beat', s.length === 3 && /snap: beat/.test(await p.$eval('.snappick', (b) => b.textContent)), s.join('|'));

// 10. destructive confirm focuses Cancel; Esc closes
await p.click('.topbar .cog');
await p.click('text=Help & states');
await p.click('button:has-text("Confirm (destructive)")');
await wait(100);
const focused = await p.evaluate(() => document.activeElement?.textContent);
await p.keyboard.press('Escape');
check('confirm opens with Cancel focused; Esc closes it', focused === 'Cancel' && !(await p.$('[role=alertdialog]')), focused);

check('no page errors', errors.length === 0, errors.join(' | '));
await b.close();
console.log(failed ? `radial e2e: ${failed} FAILED` : 'radial e2e: all ok');
process.exitCode = failed ? 1 : 0;
