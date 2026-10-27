// Isolated source fixture: no native app, engine worker, media, CT or owner profile.
import { ensureScratch } from './build-scratch/bootstrap.mjs';
const scratch = ensureScratch('build');
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(scratch.artifacts, 'output/playwright');
fs.mkdirSync(out, { recursive: true });
const bundle = await build({ entryPoints: [path.join(root, 'app/test/export-clarity.browser.tsx')], bundle: true, outfile: path.join(out, 'fixture.js'), format: 'esm', platform: 'browser', jsx: 'automatic', metafile: true,
  alias: { '@moshpit/core': path.join(root, 'core/src/index.ts'), '@moshpit/engine': path.join(root, 'engine/src/index.ts') }, define: { 'process.env.NODE_ENV': '"development"' } });
fs.writeFileSync(path.join(out, 'bundle-inputs.json'), JSON.stringify(bundle.metafile, null, 2));
const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>';
const server = createServer((req, res) => {
  const name = ({ '/fixture.js': 'fixture.js', '/fixture.css': 'fixture.css' })[req.url];
  if (req.url !== '/' && !name) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', name?.endsWith('js') ? 'text/javascript' : name ? 'text/css' : 'text/html');
  res.end(name ? fs.readFileSync(path.join(out, name)) : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const audio = page.getByRole('button', { name: 'Export audio', exact: true });
  await audio.waitFor();
  assert.equal(await audio.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.export-audio-status').textContent(), 'No source audio');
  await audio.click();
  assert.equal(await page.evaluate(() => window.qa.state().exportConfig.audio), false);
  assert.equal(await audio.getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => window.qa.undo());
  assert.equal(await audio.getAttribute('aria-pressed'), 'true');
  checks.push('Actual export switch writes audio flag, and undo restores it');
  await page.evaluate(() => window.qa.format('png-seq'));
  assert.equal(await audio.isDisabled(), true);
  assert.equal(await audio.textContent(), 'Off · PNG');
  assert.equal(await page.evaluate(() => window.qa.state().exportConfig.audio), true);
  await page.evaluate(() => window.qa.format('mp4-h264'));
  assert.equal(await audio.isDisabled(), false);
  assert.equal(await audio.getAttribute('aria-pressed'), 'true');
  checks.push('PNG reflects no audio support without losing saved preference');
  for (const [mode, label] of [['unknown','Source audio unknown'],['muted','Source audio · muted'],['present','Source audio present'],['silent','No source audio']]) {
    await page.evaluate(mode => window.qa.setup(mode), mode);
    await page.waitForFunction(label => document.querySelector('.export-audio-status').textContent === label, label);
    checks.push(mode + ' metadata updates actual form status');
  }
  for (const [width,height,scale] of [[1280,720,1],[620,700,1],[360,700,1],[620,700,1.5]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(scale => document.body.style.zoom = String(scale), scale);
    const metrics = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      audio: document.querySelector('[aria-label="Export audio"]').getBoundingClientRect().toJSON(),
      status: document.querySelector('.export-audio-status').getBoundingClientRect().toJSON() }));
    assert(metrics.scroll <= metrics.width + 1, JSON.stringify(metrics));
    assert(metrics.status.right <= width + 1 && metrics.status.left >= 0, JSON.stringify(metrics));
    await page.screenshot({path:path.join(out, 'export-'+width+'-'+scale+'.png')});
    checks.push('Form fits '+width+'px at scale '+scale);
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({checks, errors},null,2));
  console.log(JSON.stringify({out, checks},null,2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
