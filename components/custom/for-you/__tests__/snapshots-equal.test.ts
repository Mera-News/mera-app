jest.mock('@/lib/database/services/fact-service', () => ({ observeFacts: jest.fn() }));
jest.mock('@/lib/database/services/location-service', () => ({ observeAll: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/stores/section-snapshots', () => ({ loadSectionSnapshots: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

import { snapshotsEqual } from '../use-section-snapshots';
import type { SectionSnapshots } from '@/lib/stores/section-snapshots';

const make = (statement: string): SectionSnapshots =>
  ({
    topics: new Map([['t1', { id: 't1', text: 'rail strikes' }]]),
    facts: new Map([['f1', { id: 'f1', statement }]]),
    locations: new Map(),
    factStatements: new Map([['f1', statement]]),
    hasTopics: true,
  }) as unknown as SectionSnapshots;

describe('snapshotsEqual', () => {
  it('treats an identical reload as equal, so the Dashboard keeps its object', () => {
    expect(snapshotsEqual(make('I live in Utrecht'), make('I live in Utrecht'))).toBe(true);
  });

  it('sees a changed row (positive control)', () => {
    expect(snapshotsEqual(make('I live in Utrecht'), make('I live in Delft'))).toBe(false);
  });
});
