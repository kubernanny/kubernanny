import { createServer } from 'node:http';
import { Agent } from './agent';
import { Logger } from './logger';
import { renderMetrics } from './metrics/exporter';

async function bootstrap(): Promise<void> {
  const logger = new Logger('kubernanny');
  const agent = new Agent();
  const { config, identity, pairing, status } = agent;
  await agent.init();

  // The API lives under /api so the web UI can own every other path.
  await agent.listen(config.port, '0.0.0.0');
  logger.log(`agent for ${config.clusterName} on :${config.port}, checks every ${config.intervalSeconds}s, key ${identity.fingerprint}`);

  if (config.pairingLog !== false) {
    // A one-time code: logs often end up in Loki & co., and a code is worth little there.
    process.stdout.write(await pairing.banner(pairing.issue()));
  }

  if (config.metricsPort > 0) {
    createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(renderMetrics(status.snapshot()));
      } else {
        res.writeHead(404).end();
      }
    }).listen(config.metricsPort, '0.0.0.0');
  }

  // Zero-downtime rollouts (docs/ARCHITECTURE.md, Deployment): hand over, keep answering while the
  // endpoints go, finish what is in flight, then exit well within terminationGracePeriodSeconds (30).
  process.once('SIGTERM', () => {
    void agent.shutdown().finally(() => process.exit(0));
  });
  // Ctrl-C at a terminal: no endpoints to wait for.
  process.once('SIGINT', () => {
    void agent.close().finally(() => process.exit(0));
  });
}

// A promise rejected where nobody awaits it (a fire-and-forget refresh, a
// background write) is a bug to log, not a reason to end the process: every
// restart would hand whoever triggers it a crash loop. Start-up failures still
// end it, through bootstrap's own catch.
process.on('unhandledRejection', (reason) => {
  new Logger('kubernanny').error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

bootstrap().catch((err: unknown) => {
  new Logger('kubernanny').error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
