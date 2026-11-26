import { Logger } from '@nestjs/common';

import { startRelay } from './bootstrap';

const logger = new Logger('relay');

/**
 * Last resort. Every handler that takes input from the network catches its
 * own errors (the upgrade handler, the agent sockets, the HTTP routes), so
 * reaching this is a programming error. After one, the process' state is
 * unknown, so it is logged with its stack and the process exits: the
 * orchestrator restarts it and agents reconnect within seconds. Carrying on
 * would hide the bug and might keep a broken relay half-alive.
 */
function fatal(kind: string) {
  return (err: unknown) => {
    logger.fatal(`${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  };
}
process.on('uncaughtException', fatal('uncaught exception'));
process.on('unhandledRejection', fatal('unhandled rejection'));

void startRelay().then(({ port }) => logger.log(`relay on :${port}`), fatal('start failed'));
