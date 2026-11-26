import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `npm run test:coverage`: a report only, no threshold.
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['**/*.spec.ts'], reporter: ['text-summary', 'html'] },
    include: ['src/**/*.spec.ts'],
  },
});
