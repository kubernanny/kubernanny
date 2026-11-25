import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, AgentOptions } from '../agent';
import { RelayClient } from '../relay/relay-client';

export interface DemoAgent {
  app: Agent;
  publicKey: string;
  relay: RelayClient;
  close(): Promise<void>;
}

/**
 * A real agent on the demo cluster, as in production but without a port:
 * for tests in this package and in relay/ (which starts one behind its relay).
 * `env` is applied before the agent is built and removed again on close.
 */
export async function startDemoAgent(env: Record<string, string> = {}, options: AgentOptions = {}): Promise<DemoAgent> {
  const applied: Record<string, string> = {
    DEMO: 'healthy',
    // sun_path is short: keep the socket in a short /tmp path.
    INTERNAL_SOCKET: join(mkdtempSync(join(tmpdir(), 'kn-')), 'a.sock'),
    ...env,
  };
  Object.assign(process.env, applied);
  const app = new Agent(options);
  await app.init();
  return {
    app,
    publicKey: app.identity.publicKey,
    relay: app.relay,
    async close() {
      await app.close();
      for (const key of Object.keys(applied)) {
        delete process.env[key];
      }
    },
  };
}
