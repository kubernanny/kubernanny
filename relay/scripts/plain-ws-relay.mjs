// The smallest relay that does the same job as the Nest one: plain node:http
// plus ws, the same registration proof and the same AgentLink. Only for
// measure-memory.mjs, to show what Nest costs on top.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { FrameType, RegistrationChallenge, decodeFrame, encodeFrame } from '@kubernanny/protocol';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const { AgentLink } = require('../dist/core/agent-link.js');
const { parseRoute } = require('../dist/core/http.js');
const { checkRegistration } = require('../dist/core/registration.js');
const { registrationOrigin } = require('../dist/core/http.js');
const { parseLimits } = require('../dist/core/limits.js');

const limits = parseLimits(process.env);
const agents = new Map();
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: false, maxPayload: 300_000 });
const server = createServer((req, res) => {
  const route = parseRoute(new URL(req.url, 'http://x').pathname);
  if (route?.kind === 'health') {
    return res.end('{"ok":true}');
  }
  if (route?.kind !== 'call' || req.method !== 'POST') {
    return res.writeHead(404).end();
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const link = agents.get(route.agentId);
    const result = link ? await link.call(new Uint8Array(Buffer.concat(chunks))) : { kind: 'error', code: 'RELAY_AGENT_OFFLINE' };
    if (result.kind === 'error') {
      return res.writeHead(503).end(JSON.stringify({ code: result.code }));
    }
    res.writeHead(result.status).end(Buffer.from(result.body));
  });
});
server.on('upgrade', (req, socket, head) => {
  const route = parseRoute(new URL(req.url, 'http://x').pathname);
  if (route?.kind !== 'connect') {
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const challenge = new RegistrationChallenge();
    let link = null;
    ws.on('message', (data, binary) => {
      if (!binary) {
        return ws.send('pong');
      }
      const bytes = new Uint8Array(data);
      if (!link) {
        if (!checkRegistration(challenge, bytes, route.agentId, registrationOrigin(process.env.RELAY_PUBLIC_URL ?? null, req.headers.host) ?? '').ok) {
          return ws.close(4001);
        }
        link = new AgentLink({ send: (b) => ws.send(b), close: (c, r) => ws.close(c, r), bufferedAmount: () => ws.bufferedAmount, isOpen: () => ws.readyState === 1 }, limits);
        agents.set(route.agentId, link);
        return ws.send(encodeFrame(FrameType.Ready, 0, new TextEncoder().encode(JSON.stringify(link.info()))));
      }
      link.onFrame(decodeFrame(bytes));
    });
    ws.on('close', () => link && agents.get(route.agentId) === link && agents.delete(route.agentId));
    ws.send(challenge.frame());
  });
});
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
