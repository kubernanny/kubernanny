import { defineConfig } from 'vite';
import analog from '@analogjs/platform';
import angular from '@analogjs/vite-plugin-angular';
import nitro from '@analogjs/vite-plugin-nitro';
import { docsPlugin } from './build/vite-plugin-docs.ts';
import { allRoutes } from './build/routes.ts';

// Static prerendering: every route becomes a plain HTML file, no server at runtime.
const prerender = { routes: allRoutes() };

export default defineConfig(() => ({
  build: {
    target: ['es2022'],
  },
  resolve: {
    mainFields: ['module'],
  },
  server: {
    fs: {
      // The docs are read from ../docs.
      allow: ['..'],
    },
  },
  plugins: [docsPlugin(), analog({ static: true, prerender }), angular(), nitro({ static: true, prerender })],
}));
