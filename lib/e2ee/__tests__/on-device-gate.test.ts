// prepareE2EEContext is the root of every encrypted request: in on-device mode
// it refuses before any attestation fetch.

const mockAssert = jest.fn(async () => {});
jest.mock('@/lib/llm/on-device-gate', () => ({
  assertCloudAllowed: () => mockAssert(),
}));
jest.mock('@/lib/auth-client', () => ({ getJwtToken: jest.fn(), invalidateJwtCache: jest.fn() }));
jest.mock('@/lib/llm/gateway-rate-limiter', () => ({ acquire: jest.fn(), pauseFor: jest.fn() }));
jest.mock('@/lib/config/endpoints', () => ({ INFERENCE_ENDPOINT: 'https://inference.example.test' }));

import { prepareE2EEContext, rebuildE2EEContext } from '../e2ee-service';

const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);

beforeEach(() => {
  fetchSpy.mockReset();
  mockAssert.mockReset();
  const err = Object.assign(new Error('on-device'), { name: 'OnDeviceModeError' });
  mockAssert.mockRejectedValue(err);
});

it('prepareE2EEContext refuses before any request', async () => {
  await expect(prepareE2EEContext('m')).rejects.toMatchObject({ name: 'OnDeviceModeError' });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('rebuildE2EEContext refuses before any request', async () => {
  await expect(rebuildE2EEContext('m', 'ab'.repeat(32), 'ed25519')).rejects.toMatchObject({
    name: 'OnDeviceModeError',
  });
  expect(fetchSpy).not.toHaveBeenCalled();
});
