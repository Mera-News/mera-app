// The arms of `classifyError` (feed-sync-status.ts) that only the legacy status suite pinned: each
// error shape the machine can throw maps to one reader-facing code.
import { classifyError } from '@/lib/scheduler/feed-sync/feed-sync-status';

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('classifyError arms', () => {
  it.each([
    ['a no-topics-configured message', new Error('no-topics-configured'), 'no-topics-configured'],
    ['a 401 message', new Error('401 unauthenticated'), 'auth-expired'],
    ['a daily-limit code with another message', withCode('cap', 'daily-limit'), 'daily-limit'],
    ['a daily-limit message with no code', new Error('daily-limit'), 'daily-limit'],
    ['a no-topics-configured code with another message', withCode('boom', 'no-topics-configured'), 'no-topics-configured'],
    ['a no-push-token code', withCode('boom', 'no-push-token'), 'scoring-unavailable'],
    ['anything else', new Error('boom'), 'unknown'],
  ])('%s', (_name, err, code) => {
    expect(classifyError(err)).toBe(code);
  });
});
