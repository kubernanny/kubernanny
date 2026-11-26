import { describe, expect, it } from 'vitest';

import type { Config } from '../config';
import { ADMIN, DEMO_DEVICE, DevicesService, Principal } from './devices.service';
import { INTERNAL, InternalRequest, PRINCIPAL_HEADER, principalOf } from './principal';

const phone = { id: 'phone-1', name: 'Phone' } as unknown as Principal;
const devices = { byId: (id: string) => (id === 'phone-1' ? phone : null) } as unknown as DevicesService;
const config = (demo: boolean) => ({ demo: demo ? 'broken' : null }) as unknown as Config;

function request(header: string | string[] | undefined, internal: boolean): InternalRequest {
  const req = { headers: header === undefined ? {} : { [PRINCIPAL_HEADER]: header } } as InternalRequest;
  if (internal) {
    req[INTERNAL] = true;
  }
  return req;
}

describe('principalOf', () => {
  it('lets nothing through from the network, whatever the header says', () => {
    for (const header of ['admin', 'demo', 'phone-1']) {
      expect(principalOf(request(header, false), devices, config(true))).toBeNull();
    }
  });

  it('names the paired device, the admin or nobody on the internal socket', () => {
    expect(principalOf(request('phone-1', true), devices, config(false))).toBe(phone);
    expect(principalOf(request('admin', true), devices, config(false))).toBe(ADMIN);
    expect(principalOf(request('revoked-device', true), devices, config(false))).toBeNull();
    expect(principalOf(request(undefined, true), devices, config(false))).toBeNull();
    expect(principalOf(request(['phone-1', 'admin'], true), devices, config(false))).toBeNull();
  });

  it('knows the demo device only in a demo agent', () => {
    expect(principalOf(request('demo', true), devices, config(true))).toBe(DEMO_DEVICE);
    expect(principalOf(request('demo', true), devices, config(false))).toBeNull();
  });
});
