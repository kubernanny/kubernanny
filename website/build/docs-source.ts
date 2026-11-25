/**
 * Reads `docs/` of the repository at build time. Nothing is copied: the site
 * is always built from the docs as they are in the same commit.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeForFile, slugForFile } from './doc-paths.ts';

export const WEBSITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS_DIR = resolve(WEBSITE_ROOT, '..', 'docs');
export const REPO_URL = 'https://github.com/kubernanny/kubernanny';
export const BRANCH = 'main';
export const MEDIA_BASE = '/docs-media/';

/**
 * Sidebar order. Files not listed here land in "More", so a new doc appears
 * without touching the site. `label` overrides the page's own h1 in the nav.
 */
export const NAV: { title: string; items: { file: string; label?: string }[] }[] = [
  {
    title: 'Start',
    items: [
      { file: 'README.md', label: 'Overview' },
      { file: 'IN-CLUSTER.md', label: 'What runs in your cluster' },
      { file: 'PERMISSIONS.md', label: 'Permissions' },
      { file: 'CONFIGURATION.md' },
      { file: 'COMPONENTS.md', label: 'Components' },
      { file: 'CHECKS.md', label: 'Checks' },
      { file: 'SECURITY-CHECKS.md', label: 'Security checks' },
      { file: 'NOTIFICATIONS.md' },
      { file: 'RELAY.md', label: 'Remote access (relay)' },
    ],
  },
  {
    title: 'Security',
    items: [
      { file: 'SECURITY.md' },
      { file: 'COMMUNICATION.md' },
      { file: 'PROTOCOL.md', label: 'Protocol' },
      // Every decision record (decisions/NNNN-*.md) follows here by itself, numbered, see buildNav.
      { file: 'decisions/README.md', label: 'Decisions' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { file: 'API.md', label: 'HTTP API' },
      { file: 'ARCHITECTURE.md' },
      { file: 'DEVELOPMENT.md' },
      { file: 'RELEASING.md', label: 'Releasing the apps' },
      { file: 'DESIGN.md' },
      { file: 'SCREENSHOTS.md' },
      { file: 'ROADMAP.md' },
    ],
  },
];

/** Decision records are listed under "Decisions" automatically, so a new ADR needs no change here. */
const DECISION = /^decisions\/(\d{4})-.+\.md$/;

/** Every markdown file below `docs/`, relative and with `/` separators. */
export function listDocFiles(dir = DOCS_DIR): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        out.push(relative(dir, full).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

export function readDoc(file: string, dir = DOCS_DIR): string {
  return readFileSync(join(dir, file), 'utf8');
}

export interface NavEntry {
  file: string;
  slug: string;
  route: string;
  label: string;
}

export interface NavGroup {
  title: string;
  items: NavEntry[];
}

/** The sidebar: the configured groups plus "More" for unlisted files. */
export function buildNav(files: string[], titleOf: (file: string) => string): NavGroup[] {
  const present = new Set(files);
  const listed = new Set<string>();
  const entry = (file: string, label?: string): NavEntry => ({
    file,
    slug: slugForFile(file),
    route: routeForFile(file),
    label: label ?? titleOf(file),
  });
  const decisions = files.filter((f) => DECISION.test(f)).sort();
  const groups: NavGroup[] = NAV.map((g) => ({
    title: g.title,
    items: g.items
      .filter((i) => present.has(i.file))
      .flatMap((i) => {
        listed.add(i.file);
        const own = entry(i.file, i.label);
        if (i.file !== 'decisions/README.md') {
          return [own];
        }
        decisions.forEach((d) => listed.add(d));
        return [own, ...decisions.map((d) => entry(d, `${DECISION.exec(d)![1]} ${titleOf(d).replace(/^\d{4}:\s*/, '')}`))];
      }),
  }));
  const rest = files.filter((f) => !listed.has(f));
  if (rest.length > 0) {
    groups.push({ title: 'More', items: rest.map((f) => entry(f)) });
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Every docs route, the hidden ones included: all of them are prerendered. */
export function docRoutes(files = listDocFiles()): string[] {
  return files.map(routeForFile);
}

export interface ComponentGroup {
  category: string;
  components: { name: string; deep: boolean }[];
}

/**
 * The recognised components, straight from COMPONENTS.md (whose tables a test
 * in the agent keeps in step with the catalog).
 */
export function parseComponents(markdown: string): ComponentGroup[] {
  const groups: ComponentGroup[] = [];
  let current: ComponentGroup | undefined;
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      current = { category: heading[1].trim(), components: [] };
      groups.push(current);
      continue;
    }
    const row = /^\|\s*`[^`]+`\s*\|\s*([^|]+?)\s*\|[^|]*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (row && current) {
      current.components.push({ name: row[1], deep: row[2].toLowerCase() === 'yes' });
    }
  }
  return groups.filter((g) => g.components.length > 0);
}
