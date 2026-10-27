// App-lane tests. Root vitest.config.mjs belongs to the engine lane.
import { fileURLToPath } from 'node:url';
export default { cacheDir: process.env.EDENA_SCRATCH_TEMP ? `${process.env.EDENA_SCRATCH_TEMP}/vitest-app` : undefined, test: { root: fileURLToPath(new URL('.', import.meta.url)), include: ['test/**/*.test.ts'] } };
