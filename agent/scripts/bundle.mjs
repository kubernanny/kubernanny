// The agent as two self-contained files for the image (bundle/main.js, bundle/cli.js):
// no node_modules at runtime. `npm run bundle`; the Dockerfile copies them to /app/dist.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts', 'src/cli.ts'],
  outdir: 'bundle',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minifyWhitespace: true,
  minifySyntax: true,
  // Class names stay readable in logs (Logger contexts use them).
  keepNames: true,
  legalComments: 'none',
  // ws loads these optional native helpers in a try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
