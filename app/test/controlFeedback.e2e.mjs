// Real renderer / mock media: no Electron, installed settings, hardware or owner media.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from '../../node_modules/vite/dist/node/index.js';
import { chromium } from '../../node_modules/playwright/index.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const deps = await fs.realpath(path.join(root, 'node_modules'));
const out = path.resolve(root, 'output/playwright/control-feedback/RESULTS.json');
await fs.mkdir(path.dirname(out), { recursive: true });
const alias = { '@moshpit/core': path.join(root, 'core/src/index.ts'), '@moshpit/engine': path.join(root, 'engine/src/index.ts') };
for (const name of ['react', 'react-dom', '@xyflow/react', '@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono', 'immer', 'mediabunny', 'mp4box']) alias[name] = path.join(deps, name);
const server = await createServer({ configFile: false, root: path.join(root, 'app'), cacheDir: path.join(root, '.vite/feedback-check'), resolve: { alias }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, deps] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [], checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.feedbackTest = { messages: [], documents: 0, rejectedWorkspaces: [] };
    window.moshpitControl = {
      publish() { feedbackTest.documents++; }, workspace(value) { feedbackTest.hostWorkspace = value; }, onCommit() {},
      onCommand(fn) { feedbackTest.command = fn; },
      feedback(value) {
        if (value.workspace !== feedbackTest.hostWorkspace) { feedbackTest.rejectedWorkspaces.push(value.workspace); return; }
        feedbackTest.messages.push({ at: performance.now(), ...value });
      },
    };
  });
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const ui = await import('/src/state/ui.ts'), model = await import('/src/engine/mockProject.ts');
    feedbackTest.ui = ui; feedbackTest.model = model;
    ui.setSettings(s => { s.tourDone = true; });
    ui.setUi({ folder: model.FOLDERS[0].path, libClip: model.LIBRARY[model.FOLDERS[0].path][0].path });
    ui.setWs('browse');
  });
  const latest = async () => { await page.waitForTimeout(90); return page.evaluate(() => feedbackTest.messages.at(-1)); };
  const command = async command => { await page.evaluate(command => feedbackTest.command({ command }), command); };
  await page.waitForFunction(() => feedbackTest.messages.at(-1)?.values.clip);
  let value = await latest(); assert.equal(value.workspace, 'browse'); assert.equal(value.values.zoom.text, '1x');
  assert.equal(value.values.frame.text, '0 f'); assert.equal(value.values.clip.text, '7/9');
  checks.push({ case: 'Real IN producers publish raw selection and visible name order', value });
  await command('source.selectAll'); value = await latest();
  assert.equal(value.values.in.text, '0 f'); assert.equal(value.values.out.text, '8160 f');
  await command('mark.in.nudgeForward'); await command('mark.range.nudgeForward'); value = await latest();
  // Full-length OUT pins the range; the IN nudge creates one frame of room.
  assert.equal(value.values.in.text, '1 f'); assert.equal(value.values.transpose.text, '1 f');
  await command('source.zoomIn'); value = await latest(); assert.equal(value.values.zoom.text, '1.3x');
  checks.push({ case: 'Mark, transpose and timeline zoom command readouts use actual values', value });
  await page.getByRole('textbox', { name: 'Filter clips', exact: true }).fill('street');
  value = await latest(); assert.equal(value.values.clip.text, '1/1');
  await page.getByRole('textbox', { name: 'Filter clips', exact: true }).fill('glass');
  value = await latest(); assert.equal(value.values.clip, undefined);
  await command('clip.next'); value = await latest();
  assert.equal(value.values.clip.text, '1/2'); assert.equal(value.values.in, undefined); assert.equal(value.values.frame.text, '0 f'); assert.equal(value.values.zoom.text, '1x');
  checks.push({ case: 'Search and clip switch clear hidden ordinals, old marks and old zoom', value });
  await page.getByRole('textbox', { name: 'Filter clips', exact: true }).fill('');
  // Hold the mock library response to inspect a genuine loading state rather than racing 120ms.
  await page.evaluate(async () => {
    const { engine } = await import('/src/engine/index.ts');
    const original = engine.libraryClips.bind(engine);
    engine.libraryClips = async folder => { await new Promise(resolve => { feedbackTest.finishLoad = resolve; }); return original(folder); };
  });
  await command('folder.next'); value = await latest();
  assert.equal(value.values.folder.text, '2/6');
  for (const key of ['in', 'out', 'transpose', 'clip', 'frame', 'zoom']) assert.equal(value.values[key], undefined);
  checks.push({ case: 'Folder change clears source readouts throughout loading', value });
  await page.evaluate(() => feedbackTest.finishLoad());
  await page.waitForFunction(() => feedbackTest.messages.at(-1)?.values.frame);
  await page.evaluate(() => feedbackTest.ui.setWs('home')); value = await latest(); assert.deepEqual(value.values, {});
  const storeSnapshot = await page.evaluate(async () => (await import('/src/state/controlFeedback.ts')).controlFeedback.snapshot('browse', 0, 0));
  assert.deepEqual(storeSnapshot.values, {});
  checks.push({ case: 'Workspace exit unmounts and clears the browse producers themselves', value });
  await page.evaluate(() => { feedbackTest.ui.setWs('mosh'); feedbackTest.ui.setUi({ playhead: 1e9 }); });
  value = await latest(); assert.deepEqual(Object.keys(value.values), ['frame', 'block']); assert.equal(value.values.frame.norm, 1);
  const beforeBlock = value.values.block.text;
  await command('block.next'); value = await latest(); assert.notEqual(value.values.block.text, beforeBlock);
  checks.push({ case: 'Active block selection updates its ordinal without a blocks-array change', value });
  // Let the legitimate project selection publish settle before measuring playhead-only changes.
  await page.waitForTimeout(300);
  const documents = await page.evaluate(() => feedbackTest.documents);
  await page.evaluate(async () => {
    for (let i = 1; i <= 30; i++) { feedbackTest.ui.setUi({ playhead: i }); await new Promise(resolve => setTimeout(resolve, 4)); }
  });
  value = await latest(); assert.equal(value.values.frame.text, '30 f');
  assert.equal(await page.evaluate(() => feedbackTest.documents), documents);
  checks.push({ case: 'Arrangement playhead is bounded and updates without document IPC', value });
  assert.deepEqual(await page.evaluate(() => feedbackTest.rejectedWorkspaces), []);
  assert.deepEqual(errors, []);
  await fs.writeFile(out, JSON.stringify({ checks, errors, boundary: 'Browser renderer with mock media and mocked IPC; no native or physical CT acceptance.' }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, errors, out }, null, 2));
} finally { await browser.close(); await server.close(); }
