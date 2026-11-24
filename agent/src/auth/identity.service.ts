import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KeyPair, fingerprint, fromBase64Url, generateKeyPair, keyPairFromSecret, toBase64Url } from '@kubernanny/protocol';
import { CONFIG, Config } from '../config';
import { KubeClient, KubeError } from '../kube/kube-client';

export const IDENTITY_SECRET = 'kubernanny-identity';

/**
 * The agent's static X25519 key pair: what every device pins at pairing and
 * checks on every response. Kept in the Secret `kubernanny-identity`, created
 * on first start. Losing it means pairing every device again; leaking it lets
 * someone impersonate the agent to the devices (and read recorded requests,
 * not responses: see docs/PROTOCOL.md).
 */
@Injectable()
export class IdentityService implements OnModuleInit {
  private readonly logger = new Logger(IdentityService.name);
  private pair: KeyPair | null = null;
  /** False when the key could not be stored: it then changes on every restart. */
  persistent = true;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(KubeClient) private readonly kube: KubeClient,
  ) {}

  get keyPair(): KeyPair {
    if (!this.pair) {
      throw new Error('identity not loaded');
    }
    return this.pair;
  }

  get publicKey(): string {
    return toBase64Url(this.keyPair.publicKey);
  }

  get fingerprint(): string {
    return fingerprint(this.keyPair.publicKey);
  }

  private get path(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/secrets`;
  }

  async onModuleInit(): Promise<void> {
    try {
      const secret = await this.kube.get<{ data?: { secretKey?: string } }>(`${this.path}/${IDENTITY_SECRET}`);
      const stored = Buffer.from(secret.data?.secretKey ?? '', 'base64').toString('utf8');
      this.pair = keyPairFromSecret(fromBase64Url(stored));
      return;
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) {
        return this.ephemeral(err);
      }
    }
    const pair = generateKeyPair();
    try {
      await this.kube.create(this.path, {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: IDENTITY_SECRET, labels: { 'app.kubernetes.io/name': 'kubernanny' } },
        type: 'Opaque',
        stringData: { secretKey: toBase64Url(pair.secretKey) },
      });
      this.pair = pair;
      this.logger.log(`created Secret ${this.config.namespace}/${IDENTITY_SECRET}`);
    } catch (err) {
      this.ephemeral(err, pair);
    }
  }

  private ephemeral(err: unknown, pair = generateKeyPair()): void {
    this.pair = pair;
    this.persistent = false;
    this.logger.warn(
      `cannot keep the agent key in Secret ${IDENTITY_SECRET} (${err instanceof Error ? err.message : err}); it changes on every restart and pairing is disabled`,
    );
  }
}
