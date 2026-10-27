import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (!process.env.MOSHPIT_VITE_CACHE || !process.env.MOSHPIT_BUILD_OUT) throw new Error('Use the managed app/build.mjs or npm run web launcher for E-drive outputs.');

// Renderer only. Electron main/preload are bundled by build.mjs with esbuild.
// No @vitejs/plugin-react: Vite's own TSX transform (tsconfig jsx: react-jsx) is enough; HMR is a full reload.
export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  cacheDir: process.env.MOSHPIT_VITE_CACHE,
  resolve: { alias: {
    '@moshpit/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    '@moshpit/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
  } },
  // A-1: the same isolation headers as moshpit:// (electron/protocol.ts), so dev has SharedArrayBuffer too.
  server: { port: 5174, strictPort: true, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  build: { outDir: path.join(process.env.MOSHPIT_BUILD_OUT, 'renderer'), emptyOutDir: true, target: 'es2023' },
};
