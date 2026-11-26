import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@relay/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
