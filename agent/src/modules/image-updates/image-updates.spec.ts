import { describe, expect, it, vi } from 'vitest';

import { DemoKubeClient } from '../../demo/demo-cluster';
import { DemoRegistry } from '../../demo/demo-registry';
import { CATALOG } from '../../discovery/catalog';
import type { Detected } from '../../discovery/discovery';
import { de, en } from '../../testing/i18n';
import { ModuleContext } from '../types';
import { availableUpdates, imageUpdateIssue, parseSemverTag } from './evaluate';
import { parseImageRef } from './image-ref';
import { ImageUpdatesCheck, updateTargets } from './image-updates.check';
import { nextPage, parseChallenge, REGISTRY_BACKOFF_MS, RegistryClient, TAGS_TTL_MS } from './registry-client';
import { tagSourceFor } from './tag-source';

const NOW = new Date('2026-11-25T12:00:00Z');

describe('parseImageRef', () => {
  it.each([
    ['traefik:v3.1.2', 'docker.io', 'library/traefik', 'v3.1.2'],
    ['rancher/mirrored-library-traefik:3.3.6', 'docker.io', 'rancher/mirrored-library-traefik', '3.3.6'],
    ['docker.io/grafana/grafana:12.1.0', 'docker.io', 'grafana/grafana', '12.1.0'],
    ['index.docker.io/library/redis:8.2.1', 'docker.io', 'library/redis', '8.2.1'],
    ['ghcr.io/cloudnative-pg/cloudnative-pg:1.26.1@sha256:abc', 'ghcr.io', 'cloudnative-pg/cloudnative-pg', '1.26.1'],
    ['quay.io/argoproj/argocd:v3.1.2', 'quay.io', 'argoproj/argocd', 'v3.1.2'],
    [
      'registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.16.0',
      'registry.k8s.io',
      'kube-state-metrics/kube-state-metrics',
      'v2.16.0',
    ],
  ])('%s', (image, registry, repository, tag) => {
    expect(parseImageRef(image)).toMatchObject({ registry: { name: registry }, repository, tag });
  });

  it('never looks up an image from any other host, a digest-only image or a malformed name', () => {
    for (const image of [
      'harbor.home.example/acme/api:1.0.0',
      'localhost:5000/x:1.0.0',
      'ghcr.io/a/b@sha256:abc',
      'ghcr.io/A/B:1.0.0',
      'ghcr.io/a/../b:1.0.0',
    ]) {
      expect(parseImageRef(image), image).toBeNull();
    }
  });
});

describe('availableUpdates', () => {
  it('only reads plain release tags', () => {
    expect(parseSemverTag('v1.2.3')?.nums).toEqual([1, 2, 3]);
    for (const tag of ['1.2', '1.2.3-alpine', 'v1.12.0-build20250218', '2024.10.15', 'latest', '1.2.3-rc.1']) {
      expect(parseSemverTag(tag), tag).toBeNull();
    }
  });

  it('names the newest patch, minor and major, written like the running tag', () => {
    const tags = [
      'v3.3.5',
      'v3.3.6',
      'v3.3.7',
      'v3.3.10',
      'v3.4.0',
      'v3.5.3',
      'v4.0.1',
      '4.1.0',
      'v3.6.0-rc.1',
      'v99.0.0',
    ];
    expect(availableUpdates('v3.3.6', tags)).toEqual({ patch: 'v3.3.10', minor: 'v3.5.3', major: 'v4.0.1' });
    expect(availableUpdates('v3.5.3', ['v3.5.3', 'v3.5.2'])).toEqual({
      patch: undefined,
      minor: undefined,
      major: undefined,
    });
    expect(availableUpdates('3.3-alpine', tags)).toEqual({});
  });

  it('is a hint, never more, and says nothing when nothing is newer', () => {
    const issue = imageUpdateIssue(
      { key: 'traefik', name: 'Traefik', tag: '3.3.6' },
      { patch: '3.3.7', major: '4.0.1' },
    );
    expect(issue).toMatchObject({ id: 'image-updates/traefik', severity: 'info', actions: [] });
    expect(de(issue!.title)).toBe('Traefik 3.3.6: neuere Version verfügbar');
    expect(en(issue!.cause)).toBe(
      'Patch: 3.3.7. Major: 4.0.1. Read the release notes before updating: a new major version may change configuration or APIs.',
    );
    expect(imageUpdateIssue({ key: 'x', name: 'X', tag: '1.0.0' }, {})).toBeNull();
  });
});

/** A registry answering like Docker Hub: 401 with a token realm, then the tags. */
function hub(tags: string[], options: { realm?: string; link?: string; status?: number } = {}) {
  const calls: { url: string; auth?: string }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
    calls.push({ url, auth });
    if (url.startsWith('https://auth.docker.io/') || url.startsWith('https://evil.example/')) {
      return Response.json({ token: 'anon-token' });
    }
    if (options.status) {
      return new Response('', { status: options.status });
    }
    if (!auth) {
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': `Bearer realm="${options.realm ?? 'https://auth.docker.io/token'}",service="registry.docker.io",scope="repository:library/traefik:pull"`,
        },
      });
    }
    return Response.json({ name: 'library/traefik', tags }, { headers: options.link ? { link: options.link } : {} });
  });
  return { fetchFn, calls };
}

const traefik = parseImageRef('traefik:v3.3.6')!;

describe('RegistryClient', () => {
  it('fetches an anonymous pull token for that one repository, then the tags; only the repository name leaves', async () => {
    const { fetchFn, calls } = hub(['v3.3.6', 'v3.3.7']);
    expect(await new RegistryClient(fetchFn).tags(traefik, NOW)).toEqual(['v3.3.6', 'v3.3.7']);
    expect(calls.map((c) => c.url)).toEqual([
      'https://registry-1.docker.io/v2/library/traefik/tags/list?n=1000',
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Ftraefik%3Apull',
      'https://registry-1.docker.io/v2/library/traefik/tags/list?n=1000',
    ]);
    expect(calls.every((c) => !c.url.includes('3.3.6'))).toBe(true);
    expect(calls[2]!.auth).toBe('Bearer anon-token');
  });

  it('never asks a token realm the registry is not known to use', async () => {
    const { fetchFn, calls } = hub([], { realm: 'https://evil.example/token' });
    await expect(new RegistryClient(fetchFn).tags(traefik, NOW)).rejects.toThrow('no anonymous access');
    expect(calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
  });

  it('follows a redirect only where the registry is known to send clients', async () => {
    const k8s = parseImageRef('registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.16.0')!;
    const to = (location: string) =>
      vi.fn(async (url: string) =>
        url.startsWith('https://registry.k8s.io/')
          ? new Response('', { status: 307, headers: { location } })
          : Response.json({ tags: ['v2.17.0'] }),
      );
    expect(
      await new RegistryClient(to('https://us-west1-docker.pkg.dev/k8s-artifacts-prod/images/x/tags/list')).tags(
        k8s,
        NOW,
      ),
    ).toEqual(['v2.17.0']);
    const evil = to('https://evil.example/v2/x/tags/list');
    await expect(new RegistryClient(evil).tags(k8s, NOW)).rejects.toThrow('unexpected host');
    expect(evil).toHaveBeenCalledTimes(1);
  });

  it('follows Link pages on the same registry only', () => {
    expect(nextPage('</v2/library/traefik/tags/list?n=1000&last=v3.0.0>; rel="next"')).toBe(
      '/v2/library/traefik/tags/list?n=1000&last=v3.0.0',
    );
    expect(nextPage('<https://evil.example/v2/x>; rel="next"')).toBeNull();
    expect(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io"')).toEqual({
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
    });
  });

  it('keeps answers 12 h, backs off a failing registry for 15 minutes and serves the last answer meanwhile', async () => {
    let up = true;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (!up) {
        throw new Error('ECONNREFUSED');
      }
      return url.includes('auth.docker.io')
        ? Response.json({ token: 't' })
        : (init?.headers as Record<string, string>)['authorization']
          ? Response.json({ tags: ['v3.3.7'] })
          : new Response('', {
              status: 401,
              headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token"' },
            });
    });
    const client = new RegistryClient(fetchFn);
    await client.tags(traefik, NOW);
    const asked = fetchFn.mock.calls.length;
    await client.tags(traefik, new Date(NOW.getTime() + TAGS_TTL_MS - 1));
    expect(fetchFn.mock.calls.length).toBe(asked);
    up = false;
    const later = new Date(NOW.getTime() + TAGS_TTL_MS + 1);
    expect(await client.tags(traefik, later)).toEqual(['v3.3.7']);
    const failedAt = fetchFn.mock.calls.length;
    const other = parseImageRef('docker.io/grafana/grafana:12.1.0')!;
    await expect(client.tags(other, new Date(later.getTime() + REGISTRY_BACKOFF_MS - 1))).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(fetchFn.mock.calls.length).toBe(failedAt);
  });
});

const detected = (id: string, image: string) =>
  ({
    entry: CATALOG.find((e) => e.id === id)!,
    namespace: 'x',
    image,
    version: image.split(':')[1],
    workloads: [],
    services: [],
    links: [],
  }) as Detected;

describe('ImageUpdatesCheck', () => {
  it('looks up recognised components with a release tag on a supported registry, and counts the rest', () => {
    const { targets, skipped } = updateTargets([
      detected('traefik', 'traefik:v3.3.6'),
      detected('grafana', 'harbor.home.example/grafana/grafana:12.1.0'),
      detected('longhorn', 'longhornio/longhorn-manager:master-head'),
    ]);
    expect(targets.map((t) => t.key)).toEqual(['traefik']);
    expect(skipped).toBe(2);
  });

  it('is off by default and says what it sends', () => {
    const check = new ImageUpdatesCheck();
    expect(check.defaultOff).toBe(true);
    expect(en(check.privacy())).toBe(
      'Sends image names (no tags, no cluster data) to their registry: docker.io, ghcr.io, quay.io, registry.k8s.io.',
    );
  });

  it('reports newer versions as hints, and is not checkable when no registry answers', async () => {
    const ctx = (tags: () => Promise<string[]>) =>
      ({ kube: {}, now: NOW, detected: [detected('traefik', 'traefik:v3.3.6')], tags }) as unknown as ModuleContext & {
        tags: () => Promise<string[]>;
      };
    const ok = await new ImageUpdatesCheck(() => ({ tags: async () => ['v3.3.7'] })).run(
      ctx(async () => []),
      () => true,
    );
    expect(ok.issues.map((i) => [i.id, i.severity])).toEqual([['image-updates/traefik', 'info']]);
    await expect(
      new ImageUpdatesCheck(() => ({ tags: async () => Promise.reject(new Error('down')) })).run(
        ctx(async () => []),
        () => true,
      ),
    ).rejects.toThrow('No registry reachable');
  });

  it('gives the demo canned answers, so no test ever calls a registry', () => {
    expect(tagSourceFor(new DemoKubeClient())).toBeInstanceOf(DemoRegistry);
  });
});
