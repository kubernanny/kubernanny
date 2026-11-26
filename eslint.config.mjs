// One ESLint setup for every package: the maintainer's shared config
// (typescript-eslint, angular-eslint, Prettier, import sorting), with the
// overrides below. Run `npm run lint` in a package or at the root.
//
// The linter parses with the root's TypeScript 6: agent, relay and protocol
// compile with TypeScript 7, which has no JavaScript API for typescript-eslint.
import baseConfig from './node_modules/eslint-config-nlueg-angular/eslint.config.mjs';

export default [
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.angular/',
      '**/.wrangler/',
      'agent/bundle/',
      'app/android/',
      'app/ios/',
      'vendor/',
      'fastlane/',
      'scripts/*/raw/',
      'e2e/test-results/',
      // The shared config covers TypeScript and Angular templates; the
      // build and screenshot scripts in plain JavaScript stay out of it.
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      // HTML: only the app's Angular templates; index pages, the diagram and
      // the store screenshot frame are plain HTML.
      '**/*.html',
      '!app/src/app/**/*.html',
    ],
  },
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Files no tsconfig.json includes: the drift check (own tsconfig) and
          // the relay's tests, which import the agent and the Worker.
          allowDefaultProject: ['agent/drift/*.ts', 'relay/test/*.ts', 'app/*.config.ts'],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      // Non-null assertions mark what the code checked a line earlier (a Map
      // lookup after has(), a regex group after a match), which the types
      // cannot see; the alternatives are casts or dead branches.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Components are named for what they are (OverviewTab, ResourceBar, App),
    // as the Angular style guide does since v20, not with a Component suffix.
    files: ['app/**/*.ts', 'website/**/*.ts'],
    rules: {
      '@angular-eslint/component-class-suffix': 'off',
    },
  },
  {
    // Not Angular: agent, relay (NestJS), protocol, end-to-end tests.
    files: ['agent/**/*.ts', 'relay/**/*.ts', 'protocol/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      ...Object.fromEntries(
        baseConfig
          .flatMap((c) => Object.keys(c.rules ?? {}))
          .filter((rule) => rule.startsWith('@angular-eslint/'))
          .map((rule) => [rule, 'off']),
      ),
      // Hundreds of small helpers with inferred return types; what crosses a
      // process boundary is typed explicitly and checked (agent/drift,
      // protocol vectors), annotating the rest would only repeat the compiler.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // The website's components carry the site prefix.
    files: ['website/**/*.ts'],
    rules: {
      '@angular-eslint/component-selector': ['error', { prefix: ['kn', 'app'], style: 'kebab-case', type: 'element' }],
      '@angular-eslint/directive-selector': ['error', { prefix: 'kn', style: 'camelCase', type: 'attribute' }],
    },
  },
];
