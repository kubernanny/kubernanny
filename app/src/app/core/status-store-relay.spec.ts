import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { AgentClient } from './agent-client.service';
import { AgentInfo, ClusterConfig } from './agent.model';
import { ClusterStore } from './cluster-store.service';
import { adoptedRelay } from './relay-route';
import { StatusStore } from './status-store.service';

describe('adoptedRelay', () => {
  it('takes the relay an agent names, clears it when the agent has none, and ignores old agents', () => {
    expect(adoptedRelay({}, { relay: { url: 'https://relay.kubernanny.app', connected: true } })).toEqual({ relayUrl: 'https://relay.kubernanny.app' });
    expect(adoptedRelay({ relayUrl: 'https://relay.kubernanny.app' }, { relay: { url: 'https://relay.kubernanny.app', connected: false } })).toBeNull();
    expect(adoptedRelay({ relayUrl: 'https://r.example' }, { relay: null })).toEqual({ relayUrl: undefined });
    expect(adoptedRelay({}, { relay: { url: 'http://evil.example', connected: true } })).toBeNull();
  });
});

describe('StatusStore learns the relay in the background', () => {
  it('asks /info after a good status and stores the relay, at most once an hour', async () => {
    const cluster: ClusterConfig = { id: 'c1', name: 'home', url: 'http://10.0.0.5', agentKey: 'k', deviceKey: 'd', deviceId: 'x' };
    let infos = 0;
    const saved: ClusterConfig[] = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AgentClient,
          useValue: {
            status: async () => ({ cluster: 'home', light: 'green' }),
            info: async (): Promise<Partial<AgentInfo>> => {
              infos++;
              return { relay: { url: 'https://relay.kubernanny.app', connected: true } };
            },
          },
        },
        {
          provide: ClusterStore,
          useValue: {
            loaded: Promise.resolve(),
            clusters: () => [cluster],
            find: () => saved.at(-1) ?? cluster,
            save: async (c: ClusterConfig) => {
              saved.push(c);
              return c;
            },
          },
        },
      ],
    });
    const store = TestBed.inject(StatusStore);
    await store.refresh(cluster);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await store.refresh(cluster);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(infos).toBe(1);
    expect(saved).toEqual([{ ...cluster, relayUrl: 'https://relay.kubernanny.app' }]);
  });
});
