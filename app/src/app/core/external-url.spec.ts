import { describe, expect, it } from 'vitest';

import { externalUrl } from './external-url';

describe('externalUrl', () => {
  it('passes http and https', () => {
    expect(externalUrl('https://argocd.example.com/applications')).toBe(
      'https://argocd.example.com/applications',
    );
    expect(externalUrl('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080/');
  });

  it('drops every other scheme and anything unparsable', () => {
    for (const bad of [
      'javascript:alert(1)',
      'intent://x#Intent;end',
      'file:///etc/passwd',
      'kubernanny://pair?url=https://x&code=A',
      'data:text/html,x',
      '/relative',
      '',
      null,
      undefined,
    ]) {
      expect(externalUrl(bad)).toBeNull();
    }
  });
});
