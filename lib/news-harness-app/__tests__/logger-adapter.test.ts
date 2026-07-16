jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { appHarnessLogger } from '../logger-adapter';
import logger from '@/lib/logger';

const mockLogger = logger as unknown as {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};

describe('appHarnessLogger', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates debug/info/warn straight through', () => {
    appHarnessLogger.debug('d', { a: 1 });
    appHarnessLogger.info('i', { b: 2 });
    appHarnessLogger.warn('w', { c: 3 });
    expect(mockLogger.debug).toHaveBeenCalledWith('d', { a: 1 });
    expect(mockLogger.info).toHaveBeenCalledWith('i', { b: 2 });
    expect(mockLogger.warn).toHaveBeenCalledWith('w', { c: 3 });
  });

  it('maps error to logger.error(msg, undefined, ctx)', () => {
    appHarnessLogger.error('e', { d: 4 });
    expect(mockLogger.error).toHaveBeenCalledWith('e', undefined, { d: 4 });
  });
});
