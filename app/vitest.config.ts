import { defineConfig } from 'vitest/config';

// Ionic imports `@ionic/core/components` as a
// directory, which Node's ESM resolver refuses; inlining lets the alias apply.
export default defineConfig({
  resolve: {
    alias: [{ find: /^@ionic\/core\/components$/, replacement: '@ionic/core/components/index.js' }],
  },
  test: {
    environment: 'jsdom',
    server: { deps: { inline: [/@ionic\/angular/, /@ionic\/core/] } },
  },
});
