import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActionSheetController, AlertController, ModalController, ToastController } from '@ionic/angular/standalone';
import { describe, expect, it } from 'vitest';
import { advisoryLinks, issueCards } from '../cluster/cluster-view';
import { ClusterConfig, Issue, ModuleView } from '../core/agent.model';
import { provideI18nTesting } from '../i18n/provide-i18n';
import { translatorFor } from '../i18n/translator';
import { IssueList } from './issue-list';

const de = translatorFor('de');

const NOW = new Date('2026-11-24T12:00:00Z');

const vuln: Issue = {
  id: 'vulnerabilities/cnpg',
  check: 'vulnerabilities',
  module: 'vulnerabilities',
  severity: 'warning',
  title: 'CloudNativePG 1.26.1: 1 bekannte Schwachstelle',
  cause: 'GHSA-423p-g724-fr39 (kritisch, CVSS 9,9). Behoben in 1.28.3.',
  actions: [],
  since: '2026-11-24T11:00:00Z',
  advisories: ['GHSA-423p-g724-fr39', 'GO-2026-5106'],
};

const modules = [{ id: 'vulnerabilities', name: 'Bekannte Schwachstellen' }] as ModuleView[];

describe('advisory links', () => {
  it('links each advisory to its osv.dev page', () => {
    expect(advisoryLinks(['GHSA-423p-g724-fr39', 'GO-2026-5106'])).toEqual([
      { id: 'GHSA-423p-g724-fr39', url: 'https://osv.dev/vulnerability/GHSA-423p-g724-fr39' },
      { id: 'GO-2026-5106', url: 'https://osv.dev/vulnerability/GO-2026-5106' },
    ]);
  });

  it('builds the URL itself and drops anything that is not an advisory id', () => {
    expect(advisoryLinks(['https://evil.example/x', '../../etc', 'javascript:alert(1)?', ''])).toEqual([]);
    expect(advisoryLinks(undefined)).toEqual([]);
  });

  it('is part of the issue card, and empty for ordinary issues', () => {
    const [withLinks, plain] = issueCards([vuln, { ...vuln, id: 'pods/x', advisories: undefined }], modules, NOW, de);
    expect(withLinks.advisoryLinks.map((l) => l.id)).toEqual(['GHSA-423p-g724-fr39', 'GO-2026-5106']);
    expect(plain.advisoryLinks).toEqual([]);
  });
});

describe('issue list', () => {
  it('renders advisories as links that open in the system browser', async () => {
    // The overlays only open on a tap; rendering needs none of them.
    const overlays = [ModalController, AlertController, ToastController, ActionSheetController].map((provide) => ({ provide, useValue: {} }));
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideI18nTesting('de'), ...overlays] });
    const fixture = TestBed.createComponent(IssueList);
    fixture.componentRef.setInput('cards', issueCards([vuln], modules, NOW, de));
    fixture.componentRef.setInput('cluster', { id: 'c1', name: 'home', url: 'http://agent', agentKey: 'k', deviceKey: 'd', deviceId: 'x' } satisfies ClusterConfig);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.advisories')?.getAttribute('aria-label')).toBe('Schwachstellen bei osv.dev');
    const links = [...el.querySelectorAll<HTMLAnchorElement>('.advisories a')];
    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute('href'), a.target, a.rel])).toEqual([
      ['GHSA-423p-g724-fr39', 'https://osv.dev/vulnerability/GHSA-423p-g724-fr39', '_blank', 'noopener noreferrer'],
      ['GO-2026-5106', 'https://osv.dev/vulnerability/GO-2026-5106', '_blank', 'noopener noreferrer'],
    ]);
    expect(el.querySelector('.title')?.textContent).toContain('CloudNativePG 1.26.1');
    // The agent offers no action for a vulnerability: nothing to run from the app.
    expect(issueCards([vuln], modules, NOW, de)[0].buttons).toEqual([]);
  });
});

describe('issue list in English', () => {
  it('labels its buttons and lists in the UI language', async () => {
    const overlays = [ModalController, AlertController, ToastController, ActionSheetController].map((provide) => ({ provide, useValue: {} }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideI18nTesting('en'), ...overlays] });
    const fixture = TestBed.createComponent(IssueList);
    fixture.componentRef.setInput('cards', issueCards([vuln], modules, NOW, translatorFor('en')));
    fixture.componentRef.setInput('cluster', { id: 'c1', name: 'home', url: 'http://agent', agentKey: 'k', deviceKey: 'd', deviceId: 'x' } satisfies ClusterConfig);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.advisories')?.getAttribute('aria-label')).toBe('Vulnerabilities on osv.dev');
    expect(el.querySelector('button.icon-only')?.getAttribute('aria-label')).toBe('Silence');
    expect(el.querySelector('.meta')?.textContent).toContain('for 1 h');
  });
});
