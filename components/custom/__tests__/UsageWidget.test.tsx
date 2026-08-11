// UsageWidget — free-trial countdown (r14 #16).
//
// `trialEndsAt` is the ONE new prop this wave adds: an ISO instant from the
// server's `grantExpiresAt` field. Two things matter enough to pin here:
//
//  1. Days-remaining is computed fresh against `Date.now()` on every render —
//     never from a persisted "granted at" instant the device clock could be
//     walked to inflate. The test below fakes the system clock, not a stored
//     "start" value, to prove the countdown tracks live time.
//  2. `trialEndsAt` omitted/null renders NOTHING trial-related — a paying
//     subscriber (who the caller must never pass a value for) must not see a
//     trial label. See `ManageSubscriptionScreen`'s and `ProfileScreen`'s own
//     `grantExpiresAt && !isPremium` gating, which this component trusts.

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import UsageWidget from '../UsageWidget';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const en = require('@/lib/locales/en.json');
      const path = key.split('.');
      let v: any = path.reduce<any>((acc, part) => acc?.[part], en);
      // Minimal i18next plural resolution: `count` selects `_one`/`_other`.
      if (v === undefined && typeof opts?.count === 'number') {
        const suffix = opts.count === 1 ? '_one' : '_other';
        const last = path[path.length - 1] + suffix;
        v = [...path.slice(0, -1), last].reduce<any>((acc, part) => acc?.[part], en);
      }
      if (typeof v !== 'string') return key;
      return v.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
    },
  }),
}));

describe('UsageWidget — free trial', () => {
  const NOW = new Date('2026-08-10T00:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows days remaining when trialEndsAt is set (grant is providing access)', () => {
    // 9 days out from the faked "now".
    const trialEndsAt = new Date('2026-08-19T00:00:00.000Z').toISOString();
    render(
      <UsageWidget
        used={3}
        limit={20}
        usedLabel="Analyzed today"
        planLabel="Free Trial"
        trialEndsAt={trialEndsAt}
      />,
    );
    expect(screen.getByTestId('usage-widget-trial-days').props.children).toBe('9 days left');
  });

  it('renders no trial text for a paying subscriber (trialEndsAt null)', () => {
    render(
      <UsageWidget
        used={3}
        limit={20}
        usedLabel="Analyzed today"
        planLabel="Individual Plan"
        trialEndsAt={null}
      />,
    );
    expect(screen.queryByTestId('usage-widget-trial-days')).toBeNull();
  });

  it('renders no trial text when trialEndsAt is omitted entirely', () => {
    render(<UsageWidget used={3} limit={20} usedLabel="Analyzed today" />);
    expect(screen.queryByTestId('usage-widget-trial-days')).toBeNull();
  });

  it('floors at 0 rather than a negative count once the window has technically closed', () => {
    const trialEndsAt = new Date('2026-08-09T00:00:00.000Z').toISOString(); // in the past
    render(
      <UsageWidget
        used={3}
        limit={20}
        usedLabel="Analyzed today"
        trialEndsAt={trialEndsAt}
      />,
    );
    expect(screen.getByTestId('usage-widget-trial-days').props.children).toBe('0 days left');
  });
});
