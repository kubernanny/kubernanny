import { describe, expect, it } from 'vitest';

import { clusterLinkId, isRefreshLink } from './widget-link';

describe('clusterLinkId', () => {
  it('reads the id of a widget link', () => {
    expect(clusterLinkId('kubernanny://cluster?id=3f2b8c1e-0000-4000-8000-123456789abc')).toBe(
      '3f2b8c1e-0000-4000-8000-123456789abc',
    );
    expect(clusterLinkId('kubernanny://cluster?id=demo-broken')).toBe('demo-broken');
  });

  it('refuses anything else', () => {
    expect(clusterLinkId('kubernanny://pair?id=a')).toBeNull();
    expect(clusterLinkId('https://cluster?id=a')).toBeNull();
    expect(clusterLinkId('kubernanny://cluster?id=../../pair')).toBeNull();
    expect(clusterLinkId('kubernanny://cluster')).toBeNull();
    expect(clusterLinkId('not a url')).toBeNull();
    // The host must be exactly `cluster`.
    expect(clusterLinkId('kubernanny://evil/cluster?id=a')).toBeNull();
    expect(clusterLinkId('kubernanny://xcluster?id=a')).toBeNull();
    expect(clusterLinkId('kubernanny://cluster/x?id=a')).toBeNull();
  });
});

describe('isRefreshLink', () => {
  it('reads the refresh button of the Android widget', () => {
    expect(isRefreshLink('kubernanny://refresh')).toBe(true);
    expect(isRefreshLink('kubernanny://refresh/')).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isRefreshLink('kubernanny://cluster?id=a')).toBe(false);
    expect(isRefreshLink('kubernanny://refresh?id=a')).toBe(false);
    expect(isRefreshLink('kubernanny://refresh/x')).toBe(false);
    expect(isRefreshLink('kubernanny://xrefresh')).toBe(false);
    expect(isRefreshLink('https://refresh')).toBe(false);
    expect(isRefreshLink('not a url')).toBe(false);
  });
});
