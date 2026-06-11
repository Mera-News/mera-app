// Supplemental tests for logger.ts — __DEV__ = false branches.
// The primary logger.test.ts runs in __DEV__=true mode (jest globals).
// These tests flip __DEV__=false and use jest.resetModules() + require() to
// cover the non-DEV console paths (lines 31, 56, 141-162).
//
// In __DEV__=false mode the console.* calls inside the if(__DEV__) blocks
// are skipped — we verify the Sentry calls still happen but console is NOT called.

const mockCaptureException = jest.fn().mockReturnValue('exc-id');
const mockCaptureMessage = jest.fn().mockReturnValue('msg-id');
const mockAddBreadcrumb = jest.fn();
const mockSetUser = jest.fn();
const mockSetTag = jest.fn();
const mockSetExtra = jest.fn();
const mockStartInactiveSpan = jest.fn(() => ({ spanId: 'span-1' }));

jest.mock('@sentry/react-native', () => ({
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
  addBreadcrumb: mockAddBreadcrumb,
  setUser: mockSetUser,
  setTag: mockSetTag,
  setExtra: mockSetExtra,
  startInactiveSpan: mockStartInactiveSpan,
}));

describe('logger — __DEV__ = false (non-dev paths)', () => {
  let logger: typeof import('../logger').default;
  const mockConsoleError = jest.fn();
  const mockConsoleInfo = jest.fn();
  const mockConsoleWarn = jest.fn();
  const mockConsoleDebug = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    (global as any).__DEV__ = false;

    // Capture console methods to verify they are NOT called in non-dev mode
    (global.console as any).error = mockConsoleError;
    (global.console as any).info = mockConsoleInfo;
    (global.console as any).warn = mockConsoleWarn;
    (global.console as any).debug = mockConsoleDebug;

    logger = require('../logger').default;
  });

  afterEach(() => {
    (global as any).__DEV__ = true;
  });

  describe('captureException in non-dev mode', () => {
    it('still calls Sentry.captureException', () => {
      const err = new Error('prod error');
      logger.captureException(err);
      expect(mockCaptureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({ level: 'error' }),
      );
    });

    it('does NOT call console.error in non-dev mode', () => {
      logger.captureException(new Error('silent'));
      expect(mockConsoleError).not.toHaveBeenCalled();
    });

    it('wraps non-Error in new Error without console.error', () => {
      logger.captureException('raw string');
      const [passedErr] = mockCaptureException.mock.calls[0];
      expect(passedErr).toBeInstanceOf(Error);
      expect(passedErr.message).toBe('raw string');
      expect(mockConsoleError).not.toHaveBeenCalled();
    });
  });

  describe('captureMessage in non-dev mode', () => {
    it('still calls Sentry.captureMessage', () => {
      logger.captureMessage('prod message');
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'prod message',
        expect.objectContaining({ level: 'info' }),
      );
    });

    it('does NOT call console.info in non-dev mode', () => {
      logger.captureMessage('msg');
      expect(mockConsoleInfo).not.toHaveBeenCalled();
    });
  });

  describe('debug/info/warn/error convenience methods in non-dev mode', () => {
    it('logger.debug adds breadcrumb but does NOT call console.debug', () => {
      logger.debug('debug in prod', { key: 'val' });
      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'debug', level: 'debug' }),
      );
      expect(mockConsoleDebug).not.toHaveBeenCalled();
    });

    it('logger.info adds breadcrumb but does NOT call console.info', () => {
      logger.info('info in prod');
      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'info', level: 'info' }),
      );
      expect(mockConsoleInfo).not.toHaveBeenCalled();
    });

    it('logger.warn adds breadcrumb but does NOT call console.warn', () => {
      logger.warn('warn in prod', { extra: true });
      expect(mockAddBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'warning', level: 'warning' }),
      );
      expect(mockConsoleWarn).not.toHaveBeenCalled();
    });

    it('logger.error with error object calls captureException but NOT console.error', () => {
      const err = new Error('prod crash');
      logger.error('crash msg', err);
      expect(mockCaptureException).toHaveBeenCalled();
      expect(mockConsoleError).not.toHaveBeenCalled();
    });

    it('logger.error without error calls captureMessage with error level but NOT console.error', () => {
      logger.error('no error object');
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        'no error object',
        expect.objectContaining({ level: 'error' }),
      );
      expect(mockConsoleError).not.toHaveBeenCalled();
    });
  });
});
