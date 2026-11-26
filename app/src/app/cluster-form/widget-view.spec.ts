import { describe, expect, it } from 'vitest';
import { ClusterConfig } from '../core/agent.model';
import { PushVM, pushView } from '../core/push/push-view';
import { translatorFor } from '../i18n/translator';
import { widgetPushState, widgetView } from './widget-view';

const en = translatorFor('en');
const de = translatorFor('de');
const cluster = (extra: Partial<ClusterConfig> = {}): ClusterConfig => ({ id: 'c1', name: 'homelab', url: 'https://agent.example', agentKey: 'k', deviceKey: 'd', deviceId: 'dev-1', ...extra });
const ios = { available: true, platform: 'ios' as const };
const push = (agent: Parameters<typeof pushView>[0]['agent']): PushVM => pushView({ demo: false, native: ios, agent, marker: '🦊' }, en);

describe('widgetPushState', () => {
  it('follows the push section, where the agent is the truth', () => {
    expect(widgetPushState(push({ state: 'on', relay: true, registered: true }), cluster())).toBe('on');
    expect(widgetPushState(push({ state: 'on', relay: true, registered: false }), cluster())).toBe('off');
    // The agent forgot the registration: off, even with a push key still on the device.
    expect(widgetPushState(push({ state: 'on', relay: true, registered: false }), cluster({ push: { kid: 'a', key: 'b', token: 'c' } }))).toBe('off');
  });

  it('says push cannot be had when the deployment locked it or has no relay', () => {
    expect(widgetPushState(push({ state: 'locked', relay: false, registered: false }), cluster())).toBe('unavailable');
    expect(widgetPushState(push({ state: 'no-relay', relay: false, registered: false }), cluster())).toBe('unavailable');
  });

  it('falls back to the push key on the device while the push section is hidden', () => {
    expect(widgetPushState(null, cluster())).toBe('unknown');
    expect(widgetPushState(push(null), cluster({ push: { kid: 'a', key: 'b', token: 'c' } }))).toBe('on');
  });
});

describe('widgetView', () => {
  it('explains when the widget updates and names the grey limit in hours', () => {
    const vm = widgetView({ cluster: cluster(), push: push({ state: 'on', relay: true, registered: true }) }, de);
    expect(vm.lines).toHaveLength(4);
    expect(vm.lines[3]).toContain("„Agent antwortet nicht“");
    expect(vm.lines[2]).toContain('seit 2 Stunden');
    expect(vm.lines[2]).toContain('„Nicht aktuell“');
    expect(vm.pushLine).toBe('Push ist auf diesem Gerät an: Das Widget bleibt aktuell.');
    expect(vm.offerPush).toBe(false);
  });

  it('offers the push section only when push is off and can be switched on', () => {
    expect(widgetView({ cluster: cluster(), push: push({ state: 'on', relay: true, registered: false }) }, en)).toMatchObject({ push: 'off', offerPush: true });
    expect(widgetView({ cluster: cluster(), push: push({ state: 'locked', relay: false, registered: false }) }, en)).toMatchObject({ push: 'unavailable', offerPush: false });
    expect(widgetView({ cluster: cluster(), push: null }, en)).toMatchObject({ push: 'unknown', pushLine: '', offerPush: false });
  });

  it('keeps every line free of em and en dashes', () => {
    for (const tr of [de, en]) {
      for (const p of [push({ state: 'on', relay: true, registered: true }), push({ state: 'on', relay: true, registered: false }), push({ state: 'locked', relay: false, registered: false })]) {
        const vm = widgetView({ cluster: cluster(), push: p }, tr);
        expect([...vm.lines, vm.pushLine].join(' ')).not.toMatch(/[–—]/);
      }
    }
  });
});
