import { describe, expect, it } from 'vitest';

import { translatorFor } from '../../i18n/translator';
import { AgentPushView, ClusterConfig } from '../agent.model';
import { markedTitle, MARKER_POOL, normalizeMarker, suggestMarker } from './push-marker';
import { clusterIdForPushKey, knownClusterId } from './push-tap';
import { pushView } from './push-view';

describe('the push authenticity marker', () => {
  it('prefixes the opened title, and leaves it alone without a marker (PushMarker.java and PushKeys.swift do the same)', () => {
    expect(markedTitle('🦉', 'homelab: 2 problems')).toBe('🦉 homelab: 2 problems');
    expect(markedTitle(' Kiwi ', 'homelab: ok')).toBe('Kiwi homelab: ok');
    expect(markedTitle(null, 'homelab: ok')).toBe('homelab: ok');
    expect(markedTitle('  ', 'homelab: ok')).toBe('homelab: ok');
  });

  it('suggests three different emoji from a pool of 64, drawn at random', () => {
    expect(new Set(MARKER_POOL).size).toBe(64);
    expect(suggestMarker(() => 0)).toBe(MARKER_POOL.slice(0, 3).join(''));
    const drawn = new Set(Array.from({ length: 200 }, () => suggestMarker()));
    expect(drawn.size).toBeGreaterThan(190);
    for (const m of drawn) {
      expect(normalizeMarker(m)).toBe(m);
    }
  });

  it('accepts a word or emoji of 3 to 12 characters as a person counts them', () => {
    expect(normalizeMarker('  Kiwi  ')).toBe('Kiwi');
    expect(normalizeMarker('🦉')).toBeNull(); // one emoji: guessed too easily
    expect(normalizeMarker('ab')).toBeNull();
    expect(normalizeMarker('rote   Katze')).toBe('rote Katze');
    expect(normalizeMarker('123456789012')).toBe('123456789012');
    expect(normalizeMarker('1234567890123')).toBeNull();
    // A family emoji is one character on screen, built of seven code points with zero width joiners.
    expect(normalizeMarker('👨‍👩‍👧‍👦🦉🌵')).toBe('👨‍👩‍👧‍👦🦉🌵');
    expect(normalizeMarker('🦉'.repeat(12))).toBe('🦉'.repeat(12));
  });

  it('refuses empty markers and anything that could hide in a title', () => {
    expect(normalizeMarker('')).toBeNull();
    expect(normalizeMarker('   ')).toBeNull();
    expect(normalizeMarker('a\u0000b')).toBeNull();
    expect(normalizeMarker('a‮b')).toBeNull(); // right-to-left override
    expect(normalizeMarker('a b')).toBeNull();
    expect(normalizeMarker('a​b')).toBeNull(); // zero width space
  });
});

describe('the marker in the push section', () => {
  const en = translatorFor('en');
  const agent: AgentPushView = {
    state: 'on',
    relay: true,
    registered: true,
    deadman: { state: 'on', grace: 15 },
  };
  const native = { available: true, platform: 'android' as const };

  it('shows the marker while push is on, and nudges to choose one when there is none', () => {
    expect(pushView({ demo: false, native, agent, marker: '🦉' }, en)).toMatchObject({
      markerLine: expect.stringContaining('🦉'),
      markerActionLabel: 'Change sign',
    });
    expect(pushView({ demo: false, native, agent, marker: null }, en)).toMatchObject({
      markerLine: expect.stringContaining('No sign'),
      markerActionLabel: 'Choose a sign',
    });
  });

  it('says nothing about it while push is off', () => {
    expect(
      pushView({ demo: false, native, agent: { ...agent, registered: false }, marker: '🦉' }, en),
    ).toMatchObject({ markerLine: '', markerActionLabel: '' });
    expect(
      pushView({ demo: false, native, agent: { ...agent, state: 'locked' }, marker: '🦉' }, en),
    ).toMatchObject({ markerLine: '', markerActionLabel: '' });
  });
});

describe('where a tap on a push leads', () => {
  const cluster = (
    id: string,
    kid?: string,
    extra: Partial<ClusterConfig> = {},
  ): ClusterConfig => ({
    id,
    name: id,
    url: 'https://agent.example',
    agentKey: 'A',
    deviceKey: 'D',
    deviceId: 'dev',
    ...(kid ? { push: { kid, key: 'K', token: 'T' } } : {}),
    ...extra,
  });
  const clusters = [
    cluster('home', 'LbUGLxX9BNGEjdbP'),
    cluster('work', 'AbCdEfGhIjKlMnOp'),
    cluster('demo-broken', 'ZZZZZZZZZZZZZZZZ', { demo: 'broken' }),
  ];

  it('resolves the key id the push carried to the cluster this device registered it for', () => {
    expect(clusterIdForPushKey('LbUGLxX9BNGEjdbP', clusters)).toBe('home');
    expect(clusterIdForPushKey('AbCdEfGhIjKlMnOp', clusters)).toBe('work');
  });

  it('leads nowhere for an unknown, malformed or demo key id', () => {
    expect(clusterIdForPushKey('QQQQQQQQQQQQQQQQ', clusters)).toBeNull();
    expect(clusterIdForPushKey('ZZZZZZZZZZZZZZZZ', clusters)).toBeNull();
    expect(clusterIdForPushKey('../../pair', clusters)).toBeNull();
    expect(clusterIdForPushKey(undefined, clusters)).toBeNull();
    expect(clusterIdForPushKey(42, clusters)).toBeNull();
  });

  it('opens a linked cluster id (Android push, widget) only when it is in the list', () => {
    expect(knownClusterId('home', clusters)).toBe('home');
    expect(knownClusterId('gone', clusters)).toBeNull();
    expect(knownClusterId(null, clusters)).toBeNull();
  });
});
