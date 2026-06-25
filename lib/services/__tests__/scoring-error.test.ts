// scoring-error.test.ts — classification used to pick the header status copy.

let mockIsConnected = true;
jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: { getState: () => ({ isConnected: mockIsConnected }) },
}));

import { classifyScoringError, SCORING_ERROR_I18N_KEYS } from '../scoring-error';

beforeEach(() => {
  mockIsConnected = true;
});

describe('classifyScoringError', () => {
  it("returns 'server' when the device is connected", () => {
    mockIsConnected = true;
    expect(classifyScoringError()).toBe('server');
  });

  it("returns 'offline' when the device is not connected", () => {
    mockIsConnected = false;
    expect(classifyScoringError()).toBe('offline');
  });
});

describe('SCORING_ERROR_I18N_KEYS', () => {
  it('has a title and message key for every kind', () => {
    for (const kind of ['offline', 'server', 'generic'] as const) {
      expect(SCORING_ERROR_I18N_KEYS[kind].title).toMatch(/^errors\.scoring\./);
      expect(SCORING_ERROR_I18N_KEYS[kind].message).toMatch(/^errors\.scoring\./);
    }
  });
});
