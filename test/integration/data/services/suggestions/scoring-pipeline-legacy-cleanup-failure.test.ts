// scoring-pipeline-store: each legacy key is cleaned in its own try, so a keychain hiccup on one never
// blocks the others or throws into getPipeline. Alone in its file for the same reason as the success
// case (the once-per-process flag is module memory). The three failures are one-call spies on real
// objects (R23/R26): the settings delete for the legacy key, the keychain delete for the legacy secret,
// and AsyncStorage.removeItem.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as settingService from '@/lib/database/services/setting-service';
import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import logger from '@/lib/logger';
import { failSecureStore } from '@/test/helpers';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

afterEach(() => jest.restoreAllMocks());

it('reports each failed cleanup, keeps going, and still answers null', async () => {
  const realDelete = settingService.deleteSetting;
  jest.spyOn(settingService, 'deleteSetting').mockImplementation(async (key: string) => {
    if (key === 'async_inference_pending_job') throw new Error('settings delete failed (injected)');
    return realDelete(key);
  });
  failSecureStore('async_inference_pending_job_privkey', 'delete');
  jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('async storage failed (injected)'));

  await expect(getPipeline()).resolves.toBeNull();

  const warnings = (logger.warn as jest.Mock).mock.calls.map(([message]) => String(message));
  expect(warnings).toHaveLength(3);
  expect(warnings[0]).toContain('legacy pending-job setting cleanup failed');
  expect(warnings[1]).toContain('legacy pending-job privkey cleanup failed');
  expect(warnings[2]).toContain('legacy capability-token cleanup failed');
});
