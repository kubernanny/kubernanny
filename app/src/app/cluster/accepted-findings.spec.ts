import { describe, expect, it } from 'vitest';

import { ModuleView } from '../core/agent.model';
import { translatorFor } from '../i18n/translator';
import { acceptedFindingRows } from './accepted-findings';

const security = (extra: Partial<ModuleView>): ModuleView =>
  ({
    id: 'security',
    name: 'Security',
    issueIds: [],
    stats: [],
    links: [],
    workloads: { ready: 0, total: 0, items: [] },
    ...extra,
  }) as ModuleView;

describe('security hints accepted in Git', () => {
  it('lists each with its workload, reason and the annotation it comes from', () => {
    const m = security({
      acceptedFindings: [
        {
          key: 'root',
          finding: 'läuft womöglich als root',
          namespace: 'discourse',
          kind: 'Deployment',
          name: 'discourse',
          reason: 'the image boots runit as root',
          source: 'workload',
        },
        {
          key: 'mutable-image',
          finding: 'Image ohne feste Version',
          namespace: 'tools',
          kind: 'CronJob',
          name: 'backup',
          reason: 'rebuilt nightly',
          source: 'pod-template',
        },
      ],
    });
    expect(acceptedFindingRows(m, translatorFor('de'))).toEqual([
      {
        key: 'discourse/Deployment/discourse/root',
        name: 'discourse',
        where: 'Deployment, discourse',
        findingKey: 'root',
        finding: 'läuft womöglich als root',
        reason: 'the image boots runit as root',
        source: 'Annotation kubernanny.io/accept am Workload',
      },
      {
        key: 'tools/CronJob/backup/mutable-image',
        name: 'backup',
        where: 'CronJob, tools',
        findingKey: 'mutable-image',
        finding: 'Image ohne feste Version',
        reason: 'rebuilt nightly',
        source: 'Annotation kubernanny.io/accept am Pod-Template',
      },
    ]);
    expect(translatorFor('en').t('module.acceptedInGit', { count: 2 })).toBe('2 accepted');
  });

  it('shows nothing for a module without them', () => {
    expect(acceptedFindingRows(security({}), translatorFor('en'))).toEqual([]);
  });
});
