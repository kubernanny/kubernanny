import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LanguageService } from './language.service';

function service(deviceLanguage: string): LanguageService {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue([deviceLanguage]);
  TestBed.resetTestingModule();
  return TestBed.inject(LanguageService);
}

describe('LanguageService', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Preferences.remove({ key: 'language' });
  });

  it('follows the device until someone picks a language', async () => {
    const language = service('de-CH');
    await language.init();
    expect(language.lang()).toBe('de');
    expect(document.documentElement.lang).toBe('de');
    expect(language.translator().t('cluster.tabs.overview')).toBe('Lage');

    expect(service('pt-BR').lang()).toBe('en');
  });

  it('remembers a picked language over the device one, and can go back to the device', async () => {
    const first = service('de-DE');
    await first.choose('en');
    expect(first.lang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');

    const restarted = service('de-DE');
    await restarted.init();
    expect(restarted.choice()).toBe('en');
    expect(restarted.translator().t('cluster.tabs.overview')).toBe('Overview');

    await restarted.choose('auto');
    expect(restarted.lang()).toBe('de');
  });
});
