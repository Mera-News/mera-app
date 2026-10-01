const mockCaptureException = jest.fn().mockReturnValue('id');
jest.mock('@sentry/react-native', () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  setExtra: jest.fn(),
  startInactiveSpan: jest.fn(),
}));

import logger from '../logger';

function sent() {
  const [err, opts] = mockCaptureException.mock.calls[0];
  return { err: err as Error, extra: opts.extra };
}

describe('captureException non-Error normalisation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes a real Error through untouched, no nonErrorThrow', () => {
    const e = new Error('boom');
    logger.captureException(e, { extra: { a: 1 } });
    const { err, extra } = sent();
    expect(err).toBe(e);
    expect(extra).toEqual({ a: 1 });
  });

  it('uses a string as-is', () => {
    logger.captureException('plain failure');
    const { err, extra } = sent();
    expect(err.message).toBe('plain failure');
    expect(extra.nonErrorThrow).toEqual({ type: 'string' });
  });

  it('derives message, name and code from an object', () => {
    logger.captureException({ name: 'SQLiteError', code: 'SQLITE_FULL', message: 'disk full', secret: 'x' });
    const { err, extra } = sent();
    expect(err.message).toBe('SQLiteError [SQLITE_FULL]: disk full');
    expect(err.name).toBe('SQLiteError');
    expect(extra.nonErrorThrow).toEqual({
      type: 'object',
      keys: ['name', 'code', 'message', 'secret'],
      code: 'SQLITE_FULL',
    });
  });

  it('falls back to bounded JSON for an object without a message', () => {
    logger.captureException({ a: 1, big: 'y'.repeat(2000) });
    const { err } = sent();
    expect(err.message.startsWith('{"a":1,"big":"yyy')).toBe(true);
    expect(err.message.length).toBe(500);
  });

  it('survives circular objects', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    logger.captureException(o);
    expect(sent().err.message).toBe('{"a":1,"self":"[Circular]"}');
  });

  it('handles null and undefined', () => {
    logger.captureException(null);
    logger.captureException(undefined);
    expect(mockCaptureException.mock.calls[0][0].message).toBe('null');
    expect(mockCaptureException.mock.calls[1][0].message).toBe('undefined');
    expect(mockCaptureException.mock.calls[0][1].extra.nonErrorThrow).toEqual({ type: 'null' });
  });

  it('never throws on a hostile object', () => {
    const o = new Proxy({}, { ownKeys() { throw new Error('no'); }, get() { throw new Error('no'); } });
    expect(() => logger.captureException(o)).not.toThrow();
  });
});
