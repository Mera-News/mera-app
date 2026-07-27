// background-idle.test.ts — the low-priority idle guard that maintenance tasks
// gate on. Feed-sync running OR the inference queue busy → "busy" (false).

const mockIsRunning = jest.fn();
const mockIsBusy = jest.fn();

jest.mock('../scheduler-store', () => ({
  useSchedulerStore: { getState: () => ({ isRunning: mockIsRunning }) },
}));

jest.mock('@/lib/inference/InferenceQueue', () => ({
  inferenceQueue: { isBusy: () => mockIsBusy() },
}));

import { backgroundWorkIsIdle } from '../background-idle';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsRunning.mockReturnValue(false);
  mockIsBusy.mockReturnValue(false);
});

describe('backgroundWorkIsIdle', () => {
  it('is idle (true) when feed-sync is not running and the queue is not busy', () => {
    expect(backgroundWorkIsIdle()).toBe(true);
  });

  it('is busy (false) while feed-sync is running', () => {
    mockIsRunning.mockImplementation((name: string) => name === 'feed-sync');
    expect(backgroundWorkIsIdle()).toBe(false);
    // Short-circuits before probing the inference queue.
    expect(mockIsBusy).not.toHaveBeenCalled();
  });

  it('is busy (false) while the inference queue is busy', () => {
    mockIsBusy.mockReturnValue(true);
    expect(backgroundWorkIsIdle()).toBe(false);
  });

  it('defaults to idle (true) when a probe throws — never wedges the task', () => {
    mockIsRunning.mockImplementation(() => {
      throw new Error('store boom');
    });
    expect(backgroundWorkIsIdle()).toBe(true);
  });
});
