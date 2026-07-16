// cycle-state-machine.test.ts — recoverCycle now delegates to the scoring
// pipeline's recover().

const mockRecover = jest.fn();
const mockCaptureException = jest.fn();
const mockWarn = jest.fn();
const mockInfo = jest.fn();

jest.mock('@/lib/services/scoring-pipeline', () => ({
  recover: (...args: any[]) => mockRecover(...args),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: (...args: any[]) => mockWarn(...args),
    info: (...args: any[]) => mockInfo(...args),
    captureException: (...args: any[]) => mockCaptureException(...args),
  },
}));

import { recoverCycle } from '../cycle-state-machine';

describe('recoverCycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecover.mockResolvedValue('idle');
  });

  it('delegates to the pipeline recover() and returns idle', async () => {
    mockRecover.mockResolvedValue('idle');

    const result = await recoverCycle();

    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(result).toBe('idle');
  });

  it('returns running when the pipeline still has in-flight batches', async () => {
    mockRecover.mockResolvedValue('running');

    const result = await recoverCycle();

    expect(result).toBe('running');
  });

  it('swallows a recover() failure, logs it, and returns idle', async () => {
    const err = new Error('recover blew up');
    mockRecover.mockRejectedValue(err);

    const result = await recoverCycle();

    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ service: 'cycle-state-machine', method: 'recoverCycle' }),
      }),
    );
    expect(result).toBe('idle');
  });
});
