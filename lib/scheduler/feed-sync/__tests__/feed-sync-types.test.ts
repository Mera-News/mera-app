// feed-sync-types.test.ts — pure exports: InvalidTransitionError, NETWORK_DEPENDENT_STATES, constants

import {
  InvalidTransitionError,
  NETWORK_DEPENDENT_STATES,
  FEED_SYNC_MACHINE_KEY,
  STALE_MACHINE_AGE_MS,
} from '../feed-sync-types';

describe('InvalidTransitionError', () => {
  it('is an Error instance', () => {
    const err = new InvalidTransitionError('idle', 'scoring');
    expect(err).toBeInstanceOf(Error);
  });

  it('includes from and to states in message', () => {
    const err = new InvalidTransitionError('diffing', 'idle');
    expect(err.message).toContain('diffing');
    expect(err.message).toContain('idle');
  });

  it('formats message with arrow separator', () => {
    const err = new InvalidTransitionError('idle', 'done');
    expect(err.message).toMatch(/idle.*done/);
  });

  it('works for all valid FeedSyncState combinations', () => {
    const states = [
      'idle',
      'fetching-topic-ids',
      'diffing',
      'hydrating',
      'persisting',
      'scoring',
      'done',
      'paused-offline',
      'failed',
    ] as const;
    for (const from of states) {
      for (const to of states) {
        expect(() => new InvalidTransitionError(from, to)).not.toThrow();
      }
    }
  });
});

describe('NETWORK_DEPENDENT_STATES', () => {
  it('is an array', () => {
    expect(Array.isArray(NETWORK_DEPENDENT_STATES)).toBe(true);
  });

  it('includes fetching-topic-ids', () => {
    expect(NETWORK_DEPENDENT_STATES).toContain('fetching-topic-ids');
  });

  it('includes hydrating', () => {
    expect(NETWORK_DEPENDENT_STATES).toContain('hydrating');
  });

  it('has exactly 2 entries', () => {
    expect(NETWORK_DEPENDENT_STATES).toHaveLength(2);
  });
});

describe('FEED_SYNC_MACHINE_KEY', () => {
  it('is a non-empty string', () => {
    expect(typeof FEED_SYNC_MACHINE_KEY).toBe('string');
    expect(FEED_SYNC_MACHINE_KEY.length).toBeGreaterThan(0);
  });
});

describe('STALE_MACHINE_AGE_MS', () => {
  it('is 2 hours in milliseconds', () => {
    expect(STALE_MACHINE_AGE_MS).toBe(2 * 60 * 60 * 1000);
  });
});

export {};
