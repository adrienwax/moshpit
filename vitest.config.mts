import { fileURLToPath } from 'node:url';
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default {
  cacheDir: at('./.vite/tests'),
  resolve: { alias: { '@moshpit/core': at('./core/src/index.ts'), '@moshpit/engine': at('./engine/src/index.ts') } },
  test: { include: ['app/test/**/*.test.ts', 'engine/test/**/*.test.ts'], pool: 'forks' },
};
