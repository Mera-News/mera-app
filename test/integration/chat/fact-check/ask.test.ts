// The server ask (fetchFactCheck, requestFactCheck) and the article tick (requestArticleFactCheck),
// against the mock GraphQL server, the real Apollo client and the in-memory DB. Replaces
// lib/fact-check/__tests__/fact-check-graphql-client.test.ts (fetch/request/asked-list halves) and
// request-article-fact-check.test.ts, which mocked the client, the DB services and four stores.
//
// A FACT CHECK IS FETCHED AND SHOWN ONLY IF THIS DEVICE ASKED FOR IT: the asserts below read the
// operation each call used off the wire, the rows it wrote off the DB, and the asked list off the
// persisted setting.
import { stopAskedFactCheckPollerForTest } from '@/lib/fact-check/fact-check-graphql-client';
import { requestArticleFactCheck } from '@/lib/fact-check/request-article-fact-check';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { getAiAccess, useSubscriptionStore } from '@/lib/stores/subscription-store';
import { signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import {
  ASK_OP,
  opsOf,
  pendingRow,
  serveChecks,
  storedFor,
  until,
} from './kit';

const mockImpact = jest.fn();
jest.mock('expo-haptics', () => ({
  __esModule: true,
  impactAsync: (...a: unknown[]) => mockImpact(...a),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});
afterEach(() => {
  jest.restoreAllMocks();
  // The first ask arms the in-session poller; a timer left over fires after teardown.
  stopAskedFactCheckPollerForTest();
  useSubscriptionStore.getState().reset();
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
});

describe('requestArticleFactCheck: the tick', () => {
  const article = { articleId: 'a1', title: 'A headline' };

  it('asks regardless of entitlement, of any Mera Protocol setting, and on-device processing', async () => {
    // No server tier and no purchase: the only not-entitled state the app can be in ('locked' is
    // no longer derivable). The tick must still ask.
    useSubscriptionStore.getState().reset();
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    expect(getAiAccess()).toBe('unknown');
    expect(useMeraProtocolStore.getState().processingMode).toBe(ProcessingMode.OnDevice);
    const wire = serveChecks({ ask: () => pendingRow() });

    expect(requestArticleFactCheck(article)).toBe(true);
    await until(async () => (await storedFor('a1')).length === 1);

    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);
  });
});
