export default {
  cacheDir: process.env.EDENA_SCRATCH_TEMP ? `${process.env.EDENA_SCRATCH_TEMP}/vitest` : undefined,
  test: {
    include: ['engine/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000, // beforeAll conforms fixtures; a cold cache with every worker conforming at once takes minutes
    pool: 'forks',
  },
};
