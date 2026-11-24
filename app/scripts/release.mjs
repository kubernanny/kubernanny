#!/usr/bin/env node
/**
 * The app's store release in one command, to testers only:
 *
 *   npm run release                 next patch version
 *   npm run release -- minor        or major, or an exact version (1.2.0)
 *   npm run release:continue        upload the current version again after a stop
 *
 * Steps:
 *   1. Refuse with uncommitted changes (ALLOW_DIRTY=1 skips the check).
 *   2. Show this version's release notes (fastlane/release-notes/*.txt) and ask
 *      once, with a warning when they are unchanged since the last app release.
 *   3. Bump app/package.json (and the lock file, and MARKETING_VERSION in the
 *      Xcode project so local builds show it too), commit, tag `app-vX.Y.Z`,
 *      push when there is an `origin`. `v*` tags are the agent's releases.
 *   4. Android: build, upload to the internal test track (`fastlane android beta`).
 *   5. iOS (macOS only): build, upload to TestFlight, App Store version
 *      prepared but not submitted (`fastlane ios beta`).
 *
 * `npm run release:production` then sends the tested builds for review.
 * SKIP_ANDROID=1 / SKIP_IOS=1 leave a platform out; RELEASE_YES=1 answers the
 * question with yes; PUSH=0 keeps the commit and tag local.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '..');
const LOCALES = ['de-DE', 'en-US'];
const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;

const step = (title) => console.log(`\n${bold(`▸ ${title}`)}\n`);
const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, stdio: 'inherit' }).status === 0;
const output = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

function stop(message, hint = `Fix it, then pick up again with ${bold('npm run release:continue')}.`) {
  console.error(red(`\n${message}\n`));
  console.error(`${hint}\n`);
  process.exit(1);
}

async function confirm(question) {
  if (process.env.RELEASE_YES === '1') {
    return true;
  }
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^(j|ja|y|yes)$/i.test(answer.trim());
}

/** "1.4.2" + "minor" -> "1.5.0"; an exact version is taken as it is. */
export function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) {
    return bump;
  }
  const [major, minor, patch] = current.split('.').map(Number);
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown bump "${bump}": patch, minor, major or a version like 1.2.0`);
  }
}

const readVersion = () => JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version;

async function bump() {
  if (process.env.ALLOW_DIRTY !== '1' && output('git', ['status', '--porcelain', '--untracked-files=no']) !== '') {
    stop('Uncommitted changes. Commit or stash them first (ALLOW_DIRTY=1 skips this check).', 'Nothing was changed.');
  }

  const current = readVersion();
  const version = nextVersion(current, process.argv[2] ?? 'patch');
  const tag = `app-v${version}`;
  if (output('git', ['tag', '--list', tag])) {
    stop(`The tag ${tag} exists already.`, 'Pick another version, or `npm run release:continue` to upload it again.');
  }

  step(`Release notes for ${version}`);
  for (const locale of LOCALES) {
    const file = join(root, 'fastlane/release-notes', `${locale}.txt`);
    const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    if (!text) {
      stop(`fastlane/release-notes/${locale}.txt is missing or empty.`, 'Write the release notes, then run the release again.');
    }
    console.log(`${bold(locale)}\n${text}\n`);
  }
  const previous = `app-v${current}`;
  if (output('git', ['tag', '--list', previous]) && run('git', ['diff', '--quiet', previous, '--', 'fastlane/release-notes'])) {
    console.log(red(`These notes are unchanged since ${previous}.`));
  }
  if (!(await confirm(`${bold(`Release ${current} -> ${version} with these notes?`)} [j/N] `))) {
    stop('Stopped, nothing changed.', 'Edit fastlane/release-notes/ and run the release again.');
  }

  step(`Version ${version}`);
  if (!run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], app)) {
    stop('npm version failed.', 'Nothing was committed.');
  }
  const pbxproj = join(app, 'ios/App/App.xcodeproj/project.pbxproj');
  writeFileSync(pbxproj, readFileSync(pbxproj, 'utf8').replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`));

  const files = ['app/package.json', 'app/package-lock.json', 'app/ios/App/App.xcodeproj/project.pbxproj', 'fastlane/release-notes'];
  if (
    !run('git', ['add', '--', ...files]) ||
    !run('git', ['commit', '-m', `chore(app): release ${version}`, '--', ...files]) ||
    !run('git', ['tag', '-a', tag, '-m', `App ${version}`])
  ) {
    stop('Committing or tagging failed.', 'Check `git status`; the version files are changed but may not be committed.');
  }
  if (process.env.PUSH !== '0' && output('git', ['remote', 'get-url', 'origin'])) {
    if (!run('git', ['push', '--follow-tags', 'origin', 'HEAD'])) {
      stop('Pushing failed.', `Push by hand (git push --follow-tags origin HEAD), then ${bold('npm run release:continue')}.`);
    }
  }
}

async function upload() {
  const version = readVersion();
  if (process.env.SKIP_ANDROID !== '1') {
    step(`Android ${version}: build, upload to the internal test track`);
    if (!run('bundle', ['exec', 'fastlane', 'android', 'beta'])) {
      stop('The Android upload failed. SKIP_ANDROID=1 leaves it out on the next run.');
    }
  }
  if (process.env.SKIP_IOS !== '1') {
    if (process.platform !== 'darwin') {
      console.log(red('\niOS skipped: building needs macOS with Xcode. Run `npm run release:continue` with SKIP_ANDROID=1 on a Mac.'));
    } else {
      step(`iOS ${version}: build, upload to TestFlight, prepare the App Store version`);
      if (!run('bundle', ['exec', 'fastlane', 'ios', 'beta'])) {
        stop('The iOS upload failed. SKIP_ANDROID=1 leaves Android out on the next run (Play refuses the same build twice).');
      }
    }
  }
  console.log(
    green(
      [
        '',
        bold(`Kubernanny ${version} uploaded.`),
        '  Android: internal test track. iOS: TestFlight, once Apple has processed it.',
        '  Tested and fine? `npm run release:production` sends it for review in both stores.',
        '',
      ].join('\n'),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--continue') {
    await bump();
  }
  await upload();
}
