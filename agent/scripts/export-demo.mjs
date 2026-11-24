/**
 * Records what the three demo agents answer, for the app's built-in demo
 * (app/public/demo/<scenario>.<lang>.json, one per UI language). Starts each
 * scenario as a real agent and asks it through the end-to-end channel,
 * exactly like the app does, with the request's language field set, so the
 * demo can never drift from the agent.
 *
 *   cd agent && npm run demo:export
 *
 * Needs a build (`npm run build`). Times are stored as they were and shifted
 * to "now" by the app when it loads them.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const protocol = require('@kubernanny/protocol');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../app/public/demo');
const languages = ['en', 'de'];
const scenarios = [
  { scenario: 'broken', name: 'homelab', port: 18181 },
  { scenario: 'warning', name: 'office', port: 18182 },
  { scenario: 'healthy', name: 'staging', port: 18183 },
];

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`agent at ${url} did not start`);
}

async function exportScenario({ scenario, name, port }) {
  const socket = join(mkdtempSync(join(tmpdir(), 'kn-')), 'a.sock');
  const agent = spawn(process.execPath, ['dist/main.js'], {
    cwd: join(here, '..'),
    env: { ...process.env, DEMO: scenario, CLUSTER_NAME: name, PORT: String(port), METRICS_PORT: '0', INTERNAL_SOCKET: socket, PAIRING_LOG: 'false' },
    stdio: 'ignore',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/healthz`);
    const { publicKey } = await (await fetch(`${base}/api/identity`)).json();
    const device = protocol.generateKeyPair();
    // The first run needs a moment; ask for a fresh one so every module has answered. Both languages then read the same run.
    await record(base, publicKey, device, 'en', 'POST', '/status/refresh');
    for (const language of languages) {
      const data = await recordAll(base, publicKey, device, language, scenario);
      mkdirSync(out, { recursive: true });
      // Four decimals are plenty for charts and halve the file.
      writeFileSync(join(out, `${scenario}.${language}.json`), JSON.stringify(data, (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v)));
      console.log(`${scenario} (${language}): ${data.status.issues.length} issues, ${Object.keys(data.logs).length} logs`);
    }
  } finally {
    agent.kill();
  }
}

/** One sealed call, as the app makes it in `language`. */
async function record(base, publicKey, device, language, method, path, body) {
  const sealed = protocol.sealRequest(device, protocol.parsePublicKey(publicKey), { method, path, time: Date.now(), language, ...(body ? { body } : {}) });
  const res = await fetch(`${base}/api/e2e`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: sealed.body });
  const answer = sealed.open(new Uint8Array(await res.arrayBuffer()));
  if (answer.status >= 400) {
    throw new Error(`${method} ${path}: ${answer.status}`);
  }
  return JSON.parse(new TextDecoder().decode(answer.body));
}

/** Everything the app's demo answers from, as the agent says it in `language`. */
async function recordAll(base, publicKey, device, language, scenario) {
  const call = (method, path, body) => record(base, publicKey, device, language, method, path, body);
  const status = await call('GET', '/status');
  const logs = {};
  for (const issue of status.issues) {
    for (const index of issue.actions.filter((a) => a.type === 'logs').keys()) {
      logs[`${issue.id}#${index}`] = await call('GET', `/logs?${new URLSearchParams({ issue: issue.id, index: String(index) })}`);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    scenario,
    language,
    status,
    info: await call('GET', '/info'),
    nodes: await call('GET', '/nodes'),
    workloads: await call('GET', '/workloads'),
    storage: await call('GET', '/storage'),
    network: await call('GET', '/network'),
    events: await call('GET', '/events'),
    incidents: await call('GET', '/incidents?days=7'),
    backups: await call('GET', '/backups'),
    history: {
      6: await call('GET', '/history?hours=6'),
      24: await call('GET', '/history?hours=24'),
      168: await call('GET', '/history?hours=168'),
    },
    settings: await call('GET', '/settings'),
    logs,
  };
}

for (const s of scenarios) {
  await exportScenario(s);
}
