import 'reflect-metadata';

import { createServer, Server } from 'node:http';

import { INestApplication, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { RELAY_CONFIG, RelayConfig } from './config';
import { RelayMetrics } from './metrics';
import { RelayNotFoundFilter } from './not-found.filter';
import { RelayModule } from './relay.module';

export interface RunningRelay {
  app: INestApplication;
  port: number;
  metrics: Server | null;
  close(): Promise<void>;
}

const LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/** Starts the relay; used by main.ts and by the tests (port 0 picks a free one). */
export async function startRelay(
  options: { port?: number; metricsPort?: number; logger?: false | LogLevel } = {},
): Promise<RunningRelay> {
  const level = options.logger ?? ((process.env.LOG_LEVEL as LogLevel | undefined) || 'log');
  const app = await NestFactory.create<NestExpressApplication>(RelayModule, {
    bodyParser: false,
    logger: level === false ? false : LEVELS.slice(0, LEVELS.indexOf(level) + 1),
  });
  app.disable('x-powered-by');
  // Every answer is fresh ciphertext; an ETag would only cost a hash per response.
  app.set('etag', false);
  app.enableShutdownHooks();
  app.useGlobalFilters(new RelayNotFoundFilter());
  const config = app.get<RelayConfig>(RELAY_CONFIG);
  await app.listen(options.port ?? config.port, '0.0.0.0');
  const server = app.getHttpServer() as Server;
  // Slow clients must not hold sockets: headers quickly, the body within the call's own time.
  server.headersTimeout = 10_000;
  server.requestTimeout = config.limits.callTimeoutMs + 10_000;
  server.keepAliveTimeout = 5_000;
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  const metricsPort = options.metricsPort ?? config.metricsPort;
  let metrics: Server | null = null;
  if (metricsPort > 0) {
    const registry = app.get(RelayMetrics);
    metrics = createServer((req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(registry.render());
      } else {
        res.writeHead(404).end();
      }
    }).listen(metricsPort, '0.0.0.0');
  }
  return {
    app,
    port,
    metrics,
    async close() {
      await new Promise<void>((resolve) => (metrics ? metrics.close(() => resolve()) : resolve()));
      await app.close();
    },
  };
}
