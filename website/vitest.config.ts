import { defineConfig } from 'vitest/config';

// The build-time code (markdown, links, routes) runs in Node; no Angular needed.
export default defineConfig({
  test: {
    include: ['build/**/*.spec.ts', 'src/**/*.spec.ts'],
    environment: 'node',
  },
});
