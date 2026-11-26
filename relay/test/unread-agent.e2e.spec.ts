import {
  answerChallenge,
  decodeFrame,
  encodeReplyEnd,
  FrameType,
  generateKeyPair,
  relayAgentId,
} from '@kubernanny/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { RunningRelay, startRelay } from '../src/bootstrap';

/**
 * Second security review, H1: an "agent" that never reads its socket made
 * the relay queue every Call frame (64 KiB each) in memory, and answered
 * them blindly by guessing the sequential call ids, which freed its
 * concurrency slots for more. The reviewer's run: 1200 calls, +100 MiB RSS
 * in 5 s. Now the relay refuses calls while the socket's queue is over
 * RELAY_MAX_SOCKET_BUFFER_BYTES, and call ids cannot be guessed.
 */
describe('an agent that never reads (review H1)', () => {
  let relay: RunningRelay | null = null;
  let ws: WebSocket | null = null;

  afterEach(async () => {
    ws?.terminate();
    await relay?.close();
    relay = null;
    for (const key of Object.keys(process.env).filter((k) => k.startsWith('RELAY_'))) {
      delete process.env[key];
    }
  });

  it('bounds what the relay queues for it and gets no blind answer through', async () => {
    // Fast call limits only to make the test short; the byte limits stay at their defaults.
    Object.assign(process.env, {
      RELAY_CALLS_PER_MINUTE: '100000',
      RELAY_CALL_BURST: '100000',
      RELAY_CALL_TIMEOUT_MS: '300',
    });
    relay = await startRelay({ port: 0, metricsPort: 0, logger: false });
    const keys = generateKeyPair();
    const id = relayAgentId(keys.publicKey);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/agents/${id}/ws`);
    ws = socket;
    await new Promise<void>((resolve) =>
      socket.on('message', (data: Buffer, binary: boolean) => {
        if (!binary) {
          return;
        }
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FrameType.Challenge) {
          socket.send(answerChallenge(keys, frame.payload, `ws://127.0.0.1:${relay!.port}`));
        } else if (frame.type === FrameType.Ready) {
          resolve();
        }
      }),
    );
    // From here on the agent reads nothing: the kernel buffers fill, then the relay's queue would.
    (socket as unknown as { _socket: { pause(): void } })._socket.pause();
    socket.removeAllListeners('message');

    const body = new Uint8Array(64 * 1024).fill(1);
    const outcomes: Record<string, number> = {};
    let guess = 2;
    for (let round = 0; round < 150; round++) {
      const calls = Array.from({ length: 4 }, () =>
        fetch(`http://127.0.0.1:${relay!.port}/v1/agents/${id}/e2e`, { method: 'POST', body }).then(async (r) => {
          const code = r.status === 200 ? '200' : ((await r.json()) as { code: string }).code;
          outcomes[code] = (outcomes[code] ?? 0) + 1;
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (let i = 0; i < 4; i++) {
        socket.send(encodeReplyEnd(guess++, 200, Uint8Array.of(1)));
      }
      await Promise.all(calls);
    }
    expect(outcomes['200'] ?? 0).toBe(0); // no guessed id matched a call
    expect(outcomes['RELAY_BUSY'] ?? 0).toBeGreaterThan(0); // refused once the unread queue was full
    // What the relay holds for the agent stays near the cap, not 600 × 64 KiB.
    const queued = await queuedBytes(relay);
    expect(queued).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024 + 64);
  }, 60_000);
});

/** The bytes the relay's WebSocket for the (only) agent still holds unsent. */
async function queuedBytes(relay: RunningRelay): Promise<number> {
  const hub = relay.app.get((await import('../src/agent-hub.service')).AgentHub) as unknown as {
    agents: Map<string, { socket: WebSocket }>;
  };
  return [...hub.agents.values()].reduce((n, c) => n + c.socket.bufferedAmount, 0);
}
