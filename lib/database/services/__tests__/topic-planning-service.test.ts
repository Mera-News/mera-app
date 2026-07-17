// topic-planning-service.test.ts — the "generate more topics" widget action.

const mockGetByFact = jest.fn();
jest.mock('../topic-service', () => ({
  getByFact: (...args: unknown[]) => mockGetByFact(...args),
}));

const mockEnqueueJob = jest.fn();
const mockHasPendingJob = jest.fn();
jest.mock('../inference-job-service', () => ({
  enqueueJob: (...args: unknown[]) => mockEnqueueJob(...args),
  hasPendingJob: (...args: unknown[]) => mockHasPendingJob(...args),
}));

const mockHandleTopicGenJob = jest.fn();
jest.mock('../../../inference/handlers/topic-gen-handler', () => ({
  handleTopicGenJob: (...args: unknown[]) => mockHandleTopicGenJob(...args),
}));

const mockNotify = jest.fn();
jest.mock('../../../inference/InferenceQueue', () => ({
  inferenceQueue: { notify: (...args: unknown[]) => mockNotify(...args) },
}));

const mockProcessingMode = jest.fn();
jest.mock('../../../stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: () => ({ processingMode: mockProcessingMode() }) },
}));

jest.mock('../../../generated/graphql-types', () => ({
  ProcessingMode: { Cloud: 'CLOUD', OnDevice: 'ON_DEVICE' },
}));

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { generateMoreTopicsForFact } from '../topic-planning-service';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFact.mockResolvedValue([{ text: 'AI policy' }, { text: 'ML safety' }]);
  mockHandleTopicGenJob.mockResolvedValue({ topics: ['Robotics'] });
  mockHasPendingJob.mockResolvedValue(false);
  mockEnqueueJob.mockResolvedValue('job-1');
});

describe('generateMoreTopicsForFact', () => {
  it('cloud mode: runs handleTopicGenJob inline with append + excludeTopics', async () => {
    mockProcessingMode.mockReturnValue('CLOUD');

    const outcome = await generateMoreTopicsForFact('f1', 'Works in AI');

    expect(mockHandleTopicGenJob).toHaveBeenCalledWith({
      factId: 'f1',
      factStatement: 'Works in AI',
      useCloud: true,
      mode: 'append',
      excludeTopics: ['AI policy', 'ML safety'],
    });
    expect(outcome).toEqual({ mode: 'inline' });
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('cloud mode: returns skipped and does not throw when generation fails', async () => {
    mockProcessingMode.mockReturnValue('CLOUD');
    mockHandleTopicGenJob.mockRejectedValueOnce(new Error('gateway down'));

    const outcome = await generateMoreTopicsForFact('f1', 'Works in AI');
    expect(outcome).toEqual({ mode: 'skipped' });
  });

  it('on-device mode: enqueues an append job and notifies the queue', async () => {
    mockProcessingMode.mockReturnValue('ON_DEVICE');

    const outcome = await generateMoreTopicsForFact('f1', 'Works in AI');

    expect(mockEnqueueJob).toHaveBeenCalledWith('topic_gen', {
      factId: 'f1',
      factStatement: 'Works in AI',
      useCloud: false,
      mode: 'append',
      excludeTopics: ['AI policy', 'ML safety'],
    });
    expect(mockNotify).toHaveBeenCalled();
    expect(outcome).toEqual({ mode: 'queued' });
    expect(mockHandleTopicGenJob).not.toHaveBeenCalled();
  });

  it('on-device mode: skips when a job is already pending for the fact', async () => {
    mockProcessingMode.mockReturnValue('ON_DEVICE');
    mockHasPendingJob.mockResolvedValueOnce(true);

    const outcome = await generateMoreTopicsForFact('f1', 'Works in AI');

    expect(mockEnqueueJob).not.toHaveBeenCalled();
    expect(outcome).toEqual({ mode: 'skipped' });
  });
});
