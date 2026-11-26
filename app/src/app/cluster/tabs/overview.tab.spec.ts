import { describe, expect, it } from 'vitest';

import { HistoryView } from '../../core/agent.model';
import { translatorFor } from '../../i18n/translator';
import { usageChrome } from './overview.tab';

const view = (source: HistoryView['source']): HistoryView => ({
  source,
  hours: 6,
  ...(source === 'agent' ? { stepSeconds: 300 } : {}),
  series: [],
});

describe('the usage charts', () => {
  it('note when the agent recorded the history itself, with ranges, since it keeps a week', () => {
    expect(usageChrome(view('agent'), false)).toEqual({ ranges: true, fromAgent: true });
    expect(usageChrome(view('prometheus'), true)).toEqual({ ranges: true, fromAgent: false });
    expect(usageChrome(null, false)).toEqual({ ranges: false, fromAgent: false });
  });

  it('say where the data comes from and at which resolution, in both languages', () => {
    expect(translatorFor('de').t('overview.historyFromAgent')).toMatch(
      /^Aus Kubernanny selbst, 5-Minuten-Auflösung/,
    );
    expect(translatorFor('en').t('overview.historyFromAgent')).toMatch(
      /^From Kubernanny itself, 5-minute resolution/,
    );
  });
});
