// A confirmed "submit a feature request" proposal: mera-news-client's proposal executor files it
// through the platform host, which hands it to the app's lib/feedback.ts, which sends it to Sentry
// as user feedback. Sentry is the mockable edge; whether it was initialised is the one flag.
import * as Sentry from '@sentry/react-native';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';

let mockSentryEnabled = true;
jest.mock('@/lib/sentry-init', () => ({
  __esModule: true,
  get SENTRY_ENABLED() {
    return mockSentryEnabled;
  },
  setPrefilledReportPending: jest.fn(),
}));

const request = { type: 'submit_feature_request' as const, title: 'Dark mode widgets', summary: 'Add a dark widget option.' };

beforeEach(() => {
  mockSentryEnabled = true;
});

it('files the request once as user feedback, prefixed and tagged as coming from the agent', async () => {
  const result = await executeProposalActions([request]);

  expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
  expect(Sentry.captureFeedback).toHaveBeenCalledWith({
    message: '[Feature Request] Dark mode widgets\n\nAdd a dark widget option.',
    tags: { 'feedback.source': 'mera-agent' },
  });
  expect(result.applied).toBe(1);
  expect(result.errors).toEqual([]);
});

it('never doubles the prefix when the title already carries it', async () => {
  await executeProposalActions([{ ...request, title: '[Feature Request] Dark mode widgets' }]);

  expect(Sentry.captureFeedback).toHaveBeenCalledWith(
    expect.objectContaining({ message: '[Feature Request] Dark mode widgets\n\nAdd a dark widget option.' }),
  );
});

it('sends nothing and reports an error when Sentry was never initialised in this build', async () => {
  mockSentryEnabled = false;

  const result = await executeProposalActions([request]);

  expect(Sentry.captureFeedback).not.toHaveBeenCalled();
  expect(result.applied).toBe(0);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('feedback submission unavailable');
});
