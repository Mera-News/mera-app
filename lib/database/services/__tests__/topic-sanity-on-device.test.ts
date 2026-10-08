// The weekly topic check (via persona-hygiene) never calls the cloud AI in
// on-device mode. Reported as `skipped`, so the sweep withholds its cooldown.

jest.mock('../../index', () => ({ __esModule: true, default: { get: () => ({ query: () => ({ fetch: async () => [] }) }) } }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), warn: jest.fn(), debug: jest.fn(), captureMessage: jest.fn() },
}));
jest.mock('@/lib/news-harness-app/logger-adapter', () => ({ appHarnessLogger: {} }));
jest.mock('../setting-service', () => ({ getSetting: jest.fn(async () => null), setSetting: jest.fn() }));
const mockBatch = jest.fn();
jest.mock('../../../llm/cloudComplete', () => ({ cloudBatchComplete: (...a: unknown[]) => mockBatch(...a) }));
const mockOnDevice = jest.fn(async () => true);
jest.mock('../../../llm/on-device-gate', () => ({ isOnDeviceMode: () => mockOnDevice() }));

import { runSanityAudit } from '../topic-sanity-service';

it('returns skipped and makes no cloud call in on-device mode', async () => {
  const out = await runSanityAudit({ facts: [{ id: 'f1', statement: 'Follows cricket' }] });
  expect(out).toEqual({ incoherentFacts: [], audited: 0, skipped: true });
  expect(mockBatch).not.toHaveBeenCalled();
});
