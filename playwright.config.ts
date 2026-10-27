import { defineConfig } from '@playwright/test';
import path from 'node:path';

if (!process.env.EDENA_ARTIFACTS_DIR) throw new Error('Use npm run e2e for isolated E-drive artifacts and test profile.');

// Electron e2e: Playwright drives the built app (node app/build.mjs first). No browsers download.
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(process.env.EDENA_ARTIFACTS_DIR, 'e2e-results'),
});
