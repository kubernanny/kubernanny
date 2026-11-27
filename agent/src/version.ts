/** The agent's version. The app compares it with the version it was built with (app/src/app/core/version.ts) and suggests an update. */
export const AGENT_VERSION = '0.4.0'; // x-release-please-version

/**
 * The image this agent runs from, as CI baked it in (Dockerfile build args
 * KUBERNANNY_BUILD and KUBERNANNY_COMMIT): the image tag ("2026-11-25-16" or
 * a release "0.4.0") and the git commit. Absent in a local build.
 */
export const AGENT_BUILD = clean(process.env['KUBERNANNY_BUILD']);
export const AGENT_COMMIT = clean(process.env['KUBERNANNY_COMMIT'])?.slice(0, 12);

function clean(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s && /^[\w.+-]{1,64}$/.test(s) ? s : undefined;
}
