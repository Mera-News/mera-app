// A job queued in cloud mode (payload.useCloud) that runs after the reader
// switched to on-device must use the local engine, never the cloud AI.

jest.mock('../../../database/services/fact-service', () => ({
  getFacts: jest.fn(async () => [{ id: 'a', statement: 'Lives in Pune' }]),
  getFactSectionSnapshots: jest.fn(async () => [{ id: 'a', weight: 1 }]),
}));
jest.mock('../../../database/services/topic-service', () => ({
  getActiveTopicSnapshots: jest.fn(async () => []),
}));
jest.mock('../../../database/services/persona-summary-service', () => ({
  replaceAllSummaryStrings: jest.fn(async () => {}),
}));
const mockCloud = jest.fn();
jest.mock('../../../llm/cloudComplete', () => ({ cloudComplete: (...a: unknown[]) => mockCloud(...a) }));
const mockLocal = jest.fn(async () => '{"strings":[]}');
jest.mock('../../../llm/completeLocal', () => ({ completeLocal: (...a: unknown[]) => mockLocal(...(a as [])) }));
jest.mock('../../../llm/on-device-gate', () => ({ isOnDeviceMode: async () => true }));
jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { handlePersonaSummaryJob } from '../persona-summary-handler';

it('persona summary: a cloud payload runs locally in on-device mode', async () => {
  await handlePersonaSummaryJob({ useCloud: true });
  expect(mockCloud).not.toHaveBeenCalled();
  expect(mockLocal).toHaveBeenCalledTimes(1);
});
