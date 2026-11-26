/**
 * Admin commands inside the pod, over the internal socket:
 *
 *   kubectl -n kubernanny exec deploy/kubernanny -- node dist/cli.js pair
 *   kubectl -n kubernanny exec deploy/kubernanny -- node dist/cli.js devices
 *   kubectl -n kubernanny exec deploy/kubernanny -- node dist/cli.js revoke <device id>
 *
 * Whoever may `exec` into the pod may do this; nobody else can reach the socket.
 */
import { parseLanguage } from './config';
import { call } from './e2e/internal-server';
import { render, t, Text } from './i18n/text';

const socket = process.env.INTERNAL_SOCKET || '/tmp/kubernanny.sock';
const lang = parseLanguage(process.env.LANGUAGE);
const say = (text: Text) => render(text, lang);

async function main(args: string[]): Promise<number> {
  const [command, arg] = args;
  switch (command) {
    case 'pair': {
      const res = await call(socket, 'admin', 'POST', '/pair/code/banner');
      process.stdout.write(res.body.toString('utf8'));
      return res.status < 300 ? 0 : 1;
    }
    case 'devices': {
      const res = await call(socket, 'admin', 'GET', '/devices');
      const devices = JSON.parse(res.body.toString('utf8')) as {
        id: string;
        name: string;
        createdAt: string;
        lastSeenAt: string | null;
      }[];
      for (const d of devices) {
        process.stdout.write(
          `${say(t('cli.device', { id: d.id, name: d.name.padEnd(24), paired: d.createdAt.slice(0, 10), seen: d.lastSeenAt?.slice(0, 16) ?? '-' }))}\n`,
        );
      }
      if (devices.length === 0) {
        process.stdout.write(`${say(t('cli.noDevices'))}\n`);
      }
      return 0;
    }
    case 'revoke': {
      if (!arg) {
        break;
      }
      const res = await call(socket, 'admin', 'DELETE', `/devices/${encodeURIComponent(arg)}`);
      process.stdout.write(
        `${say(res.status === 204 ? t('cli.revoked') : t('cli.failed', { status: res.status, body: res.body.toString('utf8') }))}\n`,
      );
      return res.status === 204 ? 0 : 1;
    }
  }
  process.stderr.write(`${say(t('cli.usage'))}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `${say(t('cli.unreachable', { socket, message: err instanceof Error ? err.message : String(err) }))}\n`,
    );
    process.exit(1);
  },
);
