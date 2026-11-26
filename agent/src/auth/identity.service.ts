import { Logger } from '../logger';
import { KeyPair, fingerprint, fromBase64Url, generateKeyPair, keyPairFromSecret, toBase64Url } from '@kubernanny/protocol';
import type { Config } from '../config';
import { KubeClient } from '../kube/kube-client';
import { readAtStartup } from '../util/startup-read';

const IDENTITY_SECRET = 'kubernanny-identity';

/**
 * The agent's static X25519 key pair: what every device pins at pairing and
 * checks on every response. Kept in the Secret `kubernanny-identity`, created
 * on first start. Losing it means pairing every device again; leaking it lets
 * someone impersonate the agent to the devices (and read recorded requests,
 * not responses: see docs/PROTOCOL.md).
 */
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  private pair: KeyPair | null = null;
  /** False when the key could not be stored: it then changes on every restart. */
  persistent = true;

  constructor(
    private readonly config: Config,
    private readonly kube: KubeClient,
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

  /**
   * Reads the stored key, retrying transient errors, and throws when it stays
   * unreadable: a throwaway key would make every paired phone refuse the
   * agent as "not the pinned agent". Only a missing Secret creates a new key.
   */
  async onModuleInit(): Promise<void> {
    const secret = await readAtStartup(`Secret ${IDENTITY_SECRET}`, () => this.kube.get<{ data?: { secretKey?: string } }>(`${this.path}/${IDENTITY_SECRET}`), {
      onRetry: (err, attempt) => this.logger.warn(`cannot read Secret ${IDENTITY_SECRET} (${err instanceof Error ? err.message : err}), attempt ${attempt}; retrying`),
    });
    if (secret) {
      const stored = Buffer.from(secret.data?.secretKey ?? '', 'base64').toString('utf8');
      this.pair = keyPairFromSecret(fromBase64Url(stored));
      return;
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

  /** The Secret did not exist and could not be created: no device was paired with a stored key, so a key for this run only is safe. */
  private ephemeral(err: unknown, pair: KeyPair): void {
    this.pair = pair;
    this.persistent = false;
    this.logger.warn(
      `cannot keep the agent key in Secret ${IDENTITY_SECRET} (${err instanceof Error ? err.message : err}); it changes on every restart and pairing is disabled`,
    );
  }
}
