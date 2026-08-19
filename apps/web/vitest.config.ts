import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Playwright owns e2e; vitest must not try to run those specs.
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
