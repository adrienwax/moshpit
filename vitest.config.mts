import { fileURLToPath } from 'node:url';
const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default {
  cacheDir: process.env.EDENA_SCRATCH_TEMP ? `${process.env.EDENA_SCRATCH_TEMP}/vitest` : at('./.vite/tests'),
  resolve: { alias: { '@moshpit/core': at('./core/src/index.ts'), '@moshpit/engine': at('./engine/src/index.ts') } },
  test: { include: ['app/test/**/*.test.ts', 'engine/test/**/*.test.ts'], pool: 'forks', testTimeout: 120_000, hookTimeout: 300_000 },
};
