// Memory of the relay idle, with simulated agents connected, and under traffic.
//
//   npm run measure                     # Nest relay and the plain-ws baseline, 1000 agents
//   AGENTS=5000 node scripts/measure-memory.mjs
//
// Each simulated agent is a real WebSocket client that proves a real key, as
// the agent does; the calls are sealed-request-sized blobs answered with
// 8 KiB, the size of a typical /status answer. Numbers are the relay
// process' resident set size (VmRSS), read from /proc (Linux only).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { FrameType, answerChallenge, decodeFrame, encodeReply, generateKeyPair, relayAgentId } from '@kubernanny/protocol';
import { WebSocket } from 'ws';

const AGENTS = Number(process.env.AGENTS ?? 1000);
const CALLS = Number(process.env.CALLS ?? 2000);
const root = fileURLToPath(new URL('..', import.meta.url));

const rss = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024;

async function start(script, port) {
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, PORT: String(port), METRICS_PORT: '0', LOG_LEVEL: 'warn', RELAY_MAX_AGENTS: String(AGENTS + 10), RELAY_CALL_BURST: '100000', RELAY_CALLS_PER_MINUTE: '1000000' }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) {
        return child;
      }
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`${script} did not start`);
}

function connectAgent(port) {
  const keys = generateKeyPair();
  const id = relayAgentId(keys.publicKey);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/agents/${id}/ws`, { perMessageDeflate: false });
  const answer = new Uint8Array(8 * 1024).fill(42);
  return new Promise((resolve, reject) => {
    ws.on('message', (data, binary) => {
      if (!binary) {
        return;
      }
      const frame = decodeFrame(new Uint8Array(data));
      if (frame.type === FrameType.Challenge) {
        ws.send(answerChallenge(keys, frame.payload, `ws://127.0.0.1:${port}`));
      } else if (frame.type === FrameType.Ready) {
        resolve({ ws, id });
      } else if (frame.type === FrameType.Call) {
        for (const f of encodeReply(frame.callId, 200, answer)) {
          ws.send(f);
        }
      }
    });
    ws.on('error', reject);
  });
}

async function measure(name, script, port) {
  const child = await start(script, port);
  await sleep(2000);
  const idle = rss(child.pid);
  const agents = [];
  for (let i = 0; i < AGENTS; i += 50) {
    agents.push(...(await Promise.all(Array.from({ length: Math.min(50, AGENTS - i) }, () => connectAgent(port)))));
  }
  await sleep(3000);
  const connected = rss(child.pid);
  const body = new Uint8Array(400).fill(1);
  let ok = 0;
  const started = Date.now();
  for (let i = 0; i < CALLS; i += 50) {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, j) => fetch(`http://127.0.0.1:${port}/v1/agents/${agents[(i + j) % agents.length].id}/e2e`, { method: 'POST', body }).then((r) => r.arrayBuffer().then(() => r.status))),
    );
    ok += results.filter((s) => s === 200).length;
  }
  const seconds = (Date.now() - started) / 1000;
  const traffic = rss(child.pid);
  for (const { ws } of agents) {
    ws.terminate();
  }
  child.kill('SIGTERM');
  await sleep(500);
  return { name, idle, connected, traffic, ok, rate: Math.round(ok / seconds) };
}

const results = [await measure('NestJS relay (dist/main.js)', 'dist/main.js', 18080), await measure('plain ws baseline (scripts/plain-ws-relay.mjs)', 'scripts/plain-ws-relay.mjs', 18081)];
console.log(`\nNode ${process.version}, ${AGENTS} agents, ${CALLS} calls (400 B in, 8 KiB out)\n`);
console.log('| relay | idle | agents connected | after traffic | calls ok | calls/s |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.name} | ${r.idle.toFixed(0)} MB | ${r.connected.toFixed(0)} MB | ${r.traffic.toFixed(0)} MB | ${r.ok} | ${r.rate} |`);
}
process.exit(0);
