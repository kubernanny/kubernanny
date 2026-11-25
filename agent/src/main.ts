import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { IdentityService } from './auth/identity.service';
import { CONFIG, Config } from './config';
import { renderMetrics } from './metrics/exporter';
import { applyHttpSecurity } from './security/http-security';
import { PairingService } from './pairing/pairing';
import { StatusService } from './status/status.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get<Config>(CONFIG);
  const logger = new Logger('kubernanny');

  applyHttpSecurity(app);
  // The API lives under /api so the web UI can own every other path.
  app.setGlobalPrefix('api', { exclude: ['healthz'] });
  app.enableCors({ origin: config.corsOrigins, allowedHeaders: ['content-type'], maxAge: 3600 });
  app.enableShutdownHooks();
  if (config.webRoot && existsSync(config.webRoot)) {
    app.useStaticAssets(config.webRoot, { index: 'index.html', maxAge: '1h', dotfiles: 'deny' });
  }

  const identity = app.get(IdentityService);
  await app.listen(config.port, '0.0.0.0');
  logger.log(`agent for ${config.clusterName} on :${config.port}, checks every ${config.intervalSeconds}s, key ${identity.fingerprint}`);

  if (config.pairingLog !== false) {
    // A one-time code: logs often end up in Loki & co., and a code is worth little there.
    const pairing = app.get(PairingService);
    process.stdout.write(await pairing.banner(pairing.issue()));
  }

  if (config.metricsPort > 0) {
    const status = app.get(StatusService);
    createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(renderMetrics(status.snapshot()));
      } else {
        res.writeHead(404).end();
      }
    }).listen(config.metricsPort, '0.0.0.0');
  }
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
