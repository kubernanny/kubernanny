import { generateKeyPair, KeyPair, Language, Method, parsePublicKey, sealRequest } from '@kubernanny/protocol';
import request from 'supertest';
import { expect } from 'vitest';

export interface E2eAnswer {
  status: number;
  /** Parsed JSON, or the text when the body is not JSON. */
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Plain (outer) failure: the handshake never completed. */
  plain: boolean;
}

/** What the app does, for the tests: every call a sealed POST /api/e2e. */
export class E2eClient {
  readonly agentKey: Uint8Array;

  constructor(
    private readonly server: Parameters<typeof request>[0],
    agentKey: string,
    readonly device: KeyPair = generateKeyPair(),
    /** The UI language the app would send (`l`); none: the agent's default. */
    public language?: Language,
  ) {
    this.agentKey = parsePublicKey(agentKey);
  }

  /** The raw request body, for replay and tampering tests. */
  seal(method: Method, path: string, body?: unknown, time = Date.now()) {
    return sealRequest(this.device, this.agentKey, {
      method,
      path,
      time,
      ...(body !== undefined ? { body } : {}),
      ...(this.language ? { language: this.language } : {}),
    });
  }

  async post_raw(body: Uint8Array): Promise<request.Response> {
    return request(this.server)
      .post('/api/e2e')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from(body))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
  }

  async send(method: Method, path: string, body?: unknown, expected?: number, time = Date.now()): Promise<E2eAnswer> {
    const sealed = this.seal(method, path, body, time);
    const res = await this.post_raw(sealed.body);
    let answer: E2eAnswer;
    if (res.status !== 200) {
      answer = { status: res.status, body: JSON.parse((res.body as Buffer).toString('utf8')), plain: true };
    } else {
      const inner = sealed.open(new Uint8Array(res.body as Buffer));
      const text = new TextDecoder().decode(inner.body);
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // plain text, e.g. the banner
      }
      answer = { status: inner.status, body: parsed, plain: false };
    }
    if (expected !== undefined) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(expected);
    }
    return answer;
  }

  get(path: string, expected?: number) {
    return this.send('GET', path, undefined, expected);
  }

  post(path: string, body?: unknown, expected?: number) {
    return this.send('POST', path, body, expected);
  }

  delete(path: string, expected?: number) {
    return this.send('DELETE', path, undefined, expected);
  }
}
