// The counts card when a service of the reader's own is not answering: the paired server, the own AI
// service and the own news server each lead with their line, one at a time, until the next success.
// Faked at the network edge only: MSW serves the own hosts and the paired server.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import React from 'react';
import { gql } from '@apollo/client';
import { DashboardStatsCard } from '@/components/custom/for-you/DashboardStatsCard';
import { resetStatusCard } from '@/components/custom/for-you/feed-status-card';
import { useFeedIssue, useStatsCardLead } from '@/components/custom/for-you/use-stats-card-lead';
import client from '@/lib/apollo-client';
import { addFact } from '@/lib/database/services/fact-service';
import { cloudComplete } from '@/lib/llm/cloudComplete';
import { clearLatch, useOwnNewsHealth } from '@/lib/own-services/news-latch';
import { useOwnAiHealth } from '@/lib/own-services/ai-health';
import { ownAiState, recordOwnAiCheck, saveOwnAiFields, setOwnAiOn } from '@/lib/own-services/own-ai-state';
import { ownNewsState, recordOwnNewsCheck, saveOwnNewsFields, setOwnNewsOn } from '@/lib/own-services/own-news-state';
import { PodError } from '@/lib/own-services/pod-client';
import { recordPodError, recordPodOk, resetPodHealth } from '@/lib/own-services/pod-health';
import { forgetPairing, podState, savePairing, type PodPairing } from '@/lib/own-services/pod-state';
import { fakePod, http, HttpResponse, initI18nEn, POD_URL, server } from '@/test/helpers';
import { fakeClock, resetTransport, run } from '@/test/integration/chat/transport/transport-kit';
import { resetLinkState } from '@/test/integration/data/apollo/link-chain/kit';

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View, Text },
    Easing: { bezier: () => () => 0, linear: () => 0, inOut: () => () => 0, out: () => () => 0, in: () => () => 0, ease: () => 0, cubic: () => 0 },
    FadeInDown: {},
    FadeOutUp: {},
    useReducedMotion: () => true,
    useSharedValue: (v: unknown) => R.useRef({ value: v, set(n: unknown) { this.value = n; } }).current,
    useAnimatedStyle: () => ({}),
    withTiming: (v: unknown) => v,
    withRepeat: (v: unknown) => v,
    cancelAnimation: () => {},
  };
});
jest.mock('@/lib/mera-protocol-toolkit/core/systemRequirements', () => ({
  checkRequirements: jest.fn(() => Promise.resolve({ supported: false })),
}));

const H = { includeHiddenElements: true } as const;
const AI_LINE = "Your AI service isn't answering. Check it in Mera Protocol.";
const NEWS_LINE = "Your news server isn't answering.";
const POD_LINE = "Can't reach your server.";
const AI_URL = 'https://ai.own.test/v1/chat/completions';
const AI_KEY = 'own-ai-key-12345678';
const NEWS_KEY = 'own-news-key-12345678';
const TOKEN = 'pod-token-abcdef123456';
const pairing: PodPairing = { v: 1, baseUrl: POD_URL, deviceId: 'device-1', token: TOKEN, podName: 'Home pod', pairedAt: 1 };
const REPLY = { choices: [{ message: { content: 'own reply' } }] };
const NEWS = gql`
  query GetArticleIdsForPersona($query: PersonaQueryInput!) {
    articleIdsForPersona(query: $query) {
      topicResults {
        topicText
        articleIds
      }
    }
  }
`;
const NEWS_DATA = { data: { articleIdsForPersona: { __typename: 'PersonaArticleIds', topicResults: [] } } };

const turnOnAi = async (baseUrl = 'https://ai.own.test/v1') => {
  await saveOwnAiFields({ baseUrl, model: 'own-model', key: AI_KEY });
  await recordOwnAiCheck('connected');
  await setOwnAiOn(true, { at: 1, privacyVersion: null });
};
const turnOnNews = async (baseUrl = 'https://news.own.test') => {
  await saveOwnNewsFields({ baseUrl, key: NEWS_KEY });
  await recordOwnNewsCheck('connected', null);
  await setOwnNewsOn(true, { at: 1, privacyVersion: null });
};
const askNews = () => client.query({ query: NEWS, variables: { query: { topics: [] } }, fetchPolicy: 'no-cache' }).catch(() => undefined);
const callAi = (status: number | 'network') => {
  server.use(
    http.post(AI_URL, () => (status === 'network' ? HttpResponse.error() : status === 200 ? HttpResponse.json(REPLY) : new HttpResponse('no', { status }))),
  );
  // Retries wait on the clock, so the call runs under a driven fake one.
  return act(async () => {
    fakeClock();
    await run(cloudComplete({ systemPrompt: 's', prompt: 'p' }).catch(() => undefined));
  });
};
const lead = () => screen.queryByTestId('feed-status-lead', H);
const row = () => screen.queryByTestId('feed-status-service-row', H);

beforeAll(async () => {
  await initI18nEn();
  await addFact('I follow racing');
});
beforeEach(async () => {
  await resetTransport({ signIn: false });
  resetLinkState();
  ownAiState.resetMemory();
  ownNewsState.resetMemory();
  podState.resetMemory();
  clearLatch();
  useOwnAiHealth.setState({ health: null });
  useOwnNewsHealth.setState({ health: null });
  resetPodHealth();
  (router.push as jest.Mock).mockClear();
  await client.clearStore();
});
afterEach(() => resetStatusCard());

describe('no own mode on and not paired', () => {
  it('shows no line and no row, whatever stale health says', async () => {
    useOwnAiHealth.setState({ health: 'down' });
    useOwnNewsHealth.setState({ health: 'unreachable' });
    recordPodError(new PodError('unreachable'));
    await render(<DashboardStatsCard testID="c" />);
    for (const line of [AI_LINE, NEWS_LINE, POD_LINE]) expect(screen.queryByText(line, H)).toBeNull();
    expect(row()).toBeNull();
    let issue = true;
    const Probe = () => {
      issue = useFeedIssue();
      return null;
    };
    await render(<Probe />);
    expect(issue).toBe(false);
  });

  it('adds no render to the card lead when a health store changes', async () => {
    let renders = 0;
    const Probe = () => {
      useStatsCardLead();
      renders += 1;
      return null;
    };
    await render(<Probe />);
    const before = renders;
    await act(async () => {
      useOwnAiHealth.setState({ health: 'down' });
      useOwnNewsHealth.setState({ health: 'refused' });
      recordPodError(new PodError('refused'));
    });
    expect(renders).toBe(before);
  });
});

describe('paired server', () => {
  it('leads with its line on an unreachable or refused answer and clears on the next success', async () => {
    await savePairing(pairing);
    await render(<DashboardStatsCard testID="c" />);
    expect(screen.queryByText(POD_LINE, H)).toBeNull();
    await act(async () => recordPodError(new PodError('unreachable')));
    expect(lead()).toHaveTextContent(POD_LINE);
    await act(async () => recordPodOk());
    expect(screen.queryByText(POD_LINE, H)).toBeNull();
    await act(async () => recordPodError(new PodError('refused')));
    expect(lead()).toHaveTextContent(POD_LINE);
  });

  it('a version difference is not an outage', async () => {
    await savePairing(pairing);
    await render(<DashboardStatsCard testID="c" />);
    await act(async () => recordPodError(new PodError('phone-old')));
    expect(screen.queryByText(POD_LINE, H)).toBeNull();
  });

  it('a 401 on the news link shows it, and unpairing clears it', async () => {
    const pod = fakePod({ token: TOKEN });
    pod.answer('/graphql', 401);
    await savePairing(pairing);
    await render(<DashboardStatsCard testID="c" />);
    await act(async () => {
      await askNews();
    });
    expect(lead()).toHaveTextContent(POD_LINE);
    await act(async () => {
      await forgetPairing();
    });
    expect(screen.queryByText(POD_LINE, H)).toBeNull();
    expect(row()).toBeNull();
  });

  it('is announced and its row opens the paired server page', async () => {
    await savePairing(pairing);
    await render(<DashboardStatsCard testID="c" />);
    await act(async () => recordPodError(new PodError('unreachable')));
    expect(row()).toHaveProp('accessibilityLabel', 'Your own Mera News server');
    await fireEvent.press(screen.getByTestId('c-toggle', H));
    await fireEvent.press(row()!);
    expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-pod');
  });
});

describe('own AI service', () => {
  beforeEach(async () => {
    await turnOnAi();
  });

  it.each([
    ['a 503', 503],
    ['a 401', 401],
    ['a 403', 403],
    ['a network error', 'network' as const],
  ])('%s leads with its line, and the next 200 clears it', async (_name, status) => {
    await render(<DashboardStatsCard testID="c" />);
    expect(screen.queryByText(AI_LINE, H)).toBeNull();
    await callAi(status);
    expect(lead()).toHaveTextContent(AI_LINE);
    await callAi(200);
    expect(screen.queryByText(AI_LINE, H)).toBeNull();
  });

  it('a timeout shows it', async () => {
    server.use(http.post(AI_URL, async () => new Promise<Response>(() => {})));
    await render(<DashboardStatsCard testID="c" />);
    await act(async () => {
      fakeClock();
      await run(cloudComplete({ systemPrompt: 's', prompt: 'p' }).catch(() => undefined));
    });
    expect(lead()).toHaveTextContent(AI_LINE);
  });

  it('a 429 does not show it', async () => {
    await render(<DashboardStatsCard testID="c" />);
    await callAi(429);
    expect(screen.queryByText(AI_LINE, H)).toBeNull();
  });

  it('turning the mode off clears it, and turning it on again starts clean', async () => {
    await render(<DashboardStatsCard testID="c" />);
    await callAi(503);
    expect(lead()).toHaveTextContent(AI_LINE);
    await act(async () => {
      await setOwnAiOn(false);
    });
    expect(screen.queryByText(AI_LINE, H)).toBeNull();
    await act(async () => {
      await setOwnAiOn(true, { at: 1, privacyVersion: null });
    });
    expect(screen.queryByText(AI_LINE, H)).toBeNull();
    expect(useOwnAiHealth.getState().health).toBeNull();
  });

  it('changing the address clears it', async () => {
    await render(<DashboardStatsCard testID="c" />);
    await callAi(503);
    await act(async () => {
      await saveOwnAiFields({ baseUrl: 'https://ai2.own.test/v1', model: 'own-model', key: AI_KEY });
    });
    expect(screen.queryByText(AI_LINE, H)).toBeNull();
    expect(useOwnAiHealth.getState().health).toBeNull();
  });

  it('its row opens the own AI service page', async () => {
    await render(<DashboardStatsCard testID="c" />);
    await callAi(503);
    expect(row()).toHaveProp('accessibilityLabel', 'Your own AI service');
    await fireEvent.press(screen.getByTestId('c-toggle', H));
    await fireEvent.press(row()!);
    expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-ai');
  });

  it('a 503 sets the health down, a 200 clears it and a 429 leaves it', async () => {
    await callAi(503);
    expect(useOwnAiHealth.getState().health).toBe('down');
    await callAi(429);
    expect(useOwnAiHealth.getState().health).toBe('down');
    await callAi(200);
    expect(useOwnAiHealth.getState().health).toBe('ok');
  });
});

describe('own news server', () => {
  beforeEach(async () => {
    await turnOnNews();
  });

  it('leads with its line when the server does not answer and clears on the next success', async () => {
    server.use(http.post('https://news.own.test/graphql', () => HttpResponse.error()));
    await render(<DashboardStatsCard testID="c" />);
    await act(async () => {
      await askNews();
    });
    expect(lead()).toHaveTextContent(NEWS_LINE);
    server.use(http.post('https://news.own.test/graphql', () => HttpResponse.json(NEWS_DATA)));
    await act(async () => {
      await askNews();
    });
    expect(screen.queryByText(NEWS_LINE, H)).toBeNull();
  });

  it('a mode or address change clears it', async () => {
    await render(<DashboardStatsCard testID="c" />);
    await act(async () => useOwnNewsHealth.setState({ health: 'refused' }));
    expect(lead()).toHaveTextContent(NEWS_LINE);
    await act(async () => {
      await saveOwnNewsFields({ baseUrl: 'https://news2.own.test', key: NEWS_KEY });
    });
    expect(screen.queryByText(NEWS_LINE, H)).toBeNull();
    await turnOnNews('https://news2.own.test');
    await act(async () => useOwnNewsHealth.setState({ health: 'refused' }));
    expect(lead()).toHaveTextContent(NEWS_LINE);
    await act(async () => {
      await setOwnNewsOn(false);
    });
    expect(screen.queryByText(NEWS_LINE, H)).toBeNull();
  });

  it('its row opens the own news server page', async () => {
    await render(<DashboardStatsCard testID="c" />);
    await act(async () => useOwnNewsHealth.setState({ health: 'unreachable' }));
    expect(row()).toHaveProp('accessibilityLabel', 'Your own news server');
    await fireEvent.press(screen.getByTestId('c-toggle', H));
    await fireEvent.press(row()!);
    expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-news');
  });
});

describe('more than one down', () => {
  it('shows one line at a time: paired server, then own AI service, then own news server', async () => {
    await turnOnAi();
    await turnOnNews();
    await savePairing(pairing);
    await act(async () => {
      useOwnAiHealth.setState({ health: 'down' });
      useOwnNewsHealth.setState({ health: 'unreachable' });
      recordPodError(new PodError('unreachable'));
    });
    await render(<DashboardStatsCard testID="c" />);
    expect(screen.getAllByText(/answering|reach your server/, H)).toHaveLength(1);
    expect(lead()).toHaveTextContent(POD_LINE);
    await act(async () => recordPodOk());
    expect(lead()).toHaveTextContent(AI_LINE);
    expect(screen.getAllByTestId('feed-status-service-row', H)).toHaveLength(1);
    await act(async () => useOwnAiHealth.setState({ health: 'ok' }));
    expect(lead()).toHaveTextContent(NEWS_LINE);
  });

  it('a mode that is not on never shows its line', async () => {
    await turnOnAi();
    await act(async () => {
      useOwnNewsHealth.setState({ health: 'unreachable' });
    });
    await render(<DashboardStatsCard testID="c" />);
    expect(screen.queryByText(NEWS_LINE, H)).toBeNull();
  });
});

describe('what the line leaves alone', () => {
  it('records nothing about Mera\'s own servers', async () => {
    const { useNetworkStore } = await import('@/lib/stores/network-store');
    const { _getBreakerState } = await import('@/lib/auth-failure-breaker');
    const before = [JSON.stringify(_getBreakerState()), JSON.stringify(useNetworkStore.getState())];
    await turnOnAi();
    await callAi(503);
    await callAi(401);
    expect([JSON.stringify(_getBreakerState()), JSON.stringify(useNetworkStore.getState())]).toEqual(before);
  });
});
