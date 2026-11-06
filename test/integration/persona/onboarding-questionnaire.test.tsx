// The onboarding questionnaire on the real surface: the wizard, its chat step, the chat session and
// engine, the in-memory DB. Only the network edge is scripted (the inference gateway mock).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import OnboardingWizard from '@/components/custom/onboarding/OnboardingWizard';
import { AccountService } from '@/lib/account-service';
import { resetChatSession, retryChatTurn } from '@/lib/chat-session/chat-session';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { CANONICAL_LOCATION_KEY } from '@/lib/mera-harness/core/combined-fact';
import { getAll as getLocations } from '@/lib/database/services/location-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import * as prewarm from '@/lib/llm/prewarm';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useUserStore } from '@/lib/stores/user-store';
import en from '@/lib/locales/en.json';
import {
  defaultResponder,
  FIXTURE_ACCOUNT,
  gatewayCalls,
  initI18nEn,
  mockGateway,
  server,
  signInFixtureAccount,
  type GatewayCall,
  type GatewayResponder,
} from '@/test/helpers';
import {
  hasToolResult,
  isRouteLeg,
  personMessage,
  reply,
  resetChatModules,
  seedFacts,
  setProcessingMode,
  systemOf,
  toolCall,
  until,
} from '@/test/integration/chat/_helpers';

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const { View } = jest.requireActual('react-native');
  return { __esModule: true, default: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? <View>{children}</View> : null) };
});
jest.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => ({
  GluestackUIProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/custom/config-mera/NotificationSettingsScreen', () => ({ __esModule: true, default: () => null }));
jest.setTimeout(90_000);

const copy = en.onboarding;
const cloud = () => useCloudChatStore.getState();
const isPing = (c: GatewayCall) => c.messages.some((m) => m.content === 'ping');
/** Everything the model was asked, the readiness ping aside. */
const modelCalls = () => gatewayCalls('chat').filter((c) => !isPing(c));
const rows = () => cloud().messages.map((m) => m.content);
const turnOver = () => until(() => cloud().agentTurnState?.turnActive !== true && cloud().status === 'idle', 30_000, 'turn end');

const OPTIONS = [
  { label: 'Ukraine War', search: 'ukraine war' },
  { label: 'Ukraine Peace Talks', search: 'ukraine peace talks' },
];
const responder: GatewayResponder = (c) => {
  if (systemOf(c).includes('wants to follow a news story')) {
    return hasToolResult(c, 'proposeTrack')
      ? 'Pick the stories to follow below.'
      : reply('Pick the stories to follow below.', toolCall('proposeTrack', { options: OPTIONS }));
  }
  return defaultResponder(c);
};

const press = async (testID: string) => {
  const node = await screen.findByTestId(testID, {}, { timeout: 10_000 });
  await act(async () => {
    fireEvent.press(node);
  });
};
const type = async (text: string) => {
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('chat-input'), text);
  });
};
const send = async (text: string) => {
  await type(text);
  await press('chat-send');
  await turnOver();
};
const openWizard = async (onComplete = jest.fn()) => {
  await render(<OnboardingWizard userId={FIXTURE_ACCOUNT.userId} onComplete={onComplete} />);
  await screen.findByTestId('chat-input', {}, { timeout: 15_000 });
  return onComplete;
};
const menuCount = () => screen.queryAllByTestId('onboarding-path-card').length;
const waitForMenus = (n: number) => waitFor(() => expect(menuCount()).toBe(n), { timeout: 10_000 });
/** The reader's first chat, past where they live, with one fact saved. */
const toMenu = async () => {
  await openWizard();
  await send('I follow Formula 1 racing');
  await press('fact-choice-add-0');
  await waitForMenus(1);
};
const label = (testID: string, at = 0) => screen.getAllByTestId(testID)[at].props.accessibilityLabel;

let advanceStage: jest.SpyInstance;
beforeAll(initI18nEn);
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  useDisplayPrefsStore.setState({ liteMode: true });
  useUserStore.setState({ userPersona: null });
  prewarm.useChatReadiness.setState({ status: 'idle' });
  server.use(...mockGateway(responder));
  advanceStage = jest.spyOn(AccountService, 'advanceOnboardingStage').mockResolvedValue(undefined as never);
});
afterEach(async () => {
  advanceStage.mockRestore();
  // The step's ping must land before the test ends, or it outlives the suite.
  await until(() => prewarm.useChatReadiness.getState().status !== 'warming', 30_000, 'ping');
  resetChatSession();
  await new Promise((r) => setTimeout(r, 100));
});

describe('opening the wizard', () => {
  it('a new reader gets the intro and the first question, with no sample profile', async () => {
    await openWizard();

    await screen.findByText(/To begin, where do you live/);
    expect(screen.queryByTestId('chat-sample')).toBeNull();
    expect(screen.getByPlaceholderText(copy.placeholderHome)).toBeTruthy();
    expect(screen.getByTestId('onboarding-chip-privacy')).toBeTruthy();
    expect(screen.getByTestId('onboarding-chip-decline')).toBeTruthy();
    // The first question comes first.
    expect(screen.queryByTestId('onboarding-chip-something-else')).toBeNull();
    expect(menuCount()).toBe(0);
  });

  it('a reader with facts on file opens at the menu, with no intro and no model call', async () => {
    await seedFacts(['Lives in Delft, Netherlands']);
    await openWizard();

    await waitForMenus(1);
    expect(rows()).toEqual([copy.whatNext]);
    expect(screen.queryByText(/To begin, where do you live/)).toBeNull();
    expect(screen.queryByTestId('onboarding-chip-decline')).toBeNull();
    expect(screen.getByPlaceholderText(copy.placeholderChoose)).toBeTruthy();
    expect(modelCalls()).toHaveLength(0);
  });
});

describe('the first question', () => {
  const askedHome = (c: GatewayCall) =>
    c.messages.some((m) => m.content.includes('Your last turn asked: "To begin, where do you live?'));

  it('reaches the model with a bare answer, and adds no row', async () => {
    await openWizard();
    await send('De Pijp, Amsterdam');

    expect(askedHome(modelCalls()[0])).toBe(true);
    expect(rows()[0]).toBe('De Pijp, Amsterdam');
  });

  it('rides the first send only', async () => {
    await openWizard();
    await send('De Pijp, Amsterdam');
    const before = modelCalls().length;

    await send('Noord-Holland');

    expect(askedHome(modelCalls()[before])).toBe(false);
  });

  it('is still there on a retry of a failed first turn', async () => {
    await openWizard();
    server.use(...mockGateway((c) => (isPing(c) ? defaultResponder(c) : { status: 400, body: { error: 'nope' } })));
    await send('De Pijp, Amsterdam');
    server.use(...mockGateway(responder));
    const before = modelCalls().length;

    expect(retryChatTurn()).toBe(true);
    await turnOver();

    expect(askedHome(modelCalls()[before])).toBe(true);
  });
});

describe('How Mera handles my data', () => {
  it('asks in chat on one tap, and the reply lands in the thread', async () => {
    await openWizard();

    await press('onboarding-chip-privacy');

    await screen.findByText('E2E fixture answer.');
    expect(screen.getByTestId('chat-input').props.value).toBe('');
    expect(modelCalls().length).toBeGreaterThan(0);
    expect(screen.queryByTestId('tutorial-sheet')).toBeNull();
  });
});

describe("I'd rather not say", () => {
  it('at where you live moves to the menu with no model call', async () => {
    await openWizard();

    await press('onboarding-chip-decline');

    await waitForMenus(1);
    expect(rows()).toEqual([copy.ratherNotSay, copy.whatNext]);
    expect(modelCalls()).toHaveLength(0);
    // Earlier messages stay.
    expect(screen.getByText(/To begin, where do you live/)).toBeTruthy();

  });

  it('on the follow path goes back to the menu, and the pending follow is dropped', async () => {
    await toMenu();
    await press('onboarding-path-follow');
    await screen.findByPlaceholderText(copy.placeholderFollow);
    const before = modelCalls().length;

    await press('onboarding-chip-decline');

    await waitForMenus(2);
    expect(rows().slice(-2)).toEqual([copy.ratherNotSay, copy.whatNext]);
    expect(modelCalls()).toHaveLength(before);

    await send('What is new today?');
    expect(isRouteLeg(modelCalls()[before])).toBe(true);
  });

  it('on the profile path goes to the skill that saves nothing, so a prose reply is never forced into an offer', async () => {
    await toMenu();
    await press('onboarding-path-profile');
    await screen.findByPlaceholderText(en.onboarding.composerPlaceholder);
    const before = modelCalls().length;
    const facts = (await getFacts()).length;
    server.use(...mockGateway((c) => (isPing(c) ? defaultResponder(c) : 'No problem. Is there someone at home you care about?')));

    await press('onboarding-chip-decline');
    await turnOver();

    const [leg, ...rest] = modelCalls().slice(before);
    expect(personMessage(leg)).toBe(copy.ratherNotSay);
    expect(isRouteLeg(leg)).toBe(false);
    expect(systemOf(leg)).toContain('Either way you extract nothing and save');
    expect(rest).toHaveLength(0);
    expect(rows().at(-1)).toBe('No problem. Is there someone at home you care about?');
    expect((await getFacts()).length).toBe(facts);
    expect(menuCount()).toBe(1);
  });

  it('at where you live tells the next turn what was declined', async () => {
    await openWizard();
    await press('onboarding-chip-decline');
    await waitForMenus(1);

    await send('What is new today?');

    const sent = modelCalls()[0].messages.map((m) => m.content).join('\n');
    expect(sent).toContain('To begin, where do you live?');
    expect(sent).toContain(`They said: ${copy.ratherNotSay}`);
  });

  it('is not offered on the about path, which asks nothing', async () => {
    await toMenu();
    await press('onboarding-path-about');
    await turnOver();

    expect(screen.queryByTestId('onboarding-chip-decline')).toBeNull();
    expect(screen.getByTestId('onboarding-chip-something-else')).toBeTruthy();
  });
});

describe('the wizard after a decline', () => {
  it('Next with nothing saved reaches sources and writes nothing', async () => {
    const onComplete = await openWizard();
    await press('onboarding-next');

    expect(await screen.findByTestId('onboarding-sources-step')).toBeTruthy();
    expect(await getFacts()).toEqual([]);
    expect(await getLocations()).toEqual([]);

    await press('onboarding-next');
    await screen.findByTestId('onboarding-remind');
    await press('onboarding-next');
    await press('onboarding-guard-notifications-secondary');
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});

describe('the step', () => {
  it('moves from home to the menu once a fact is saved', async () => {
    await openWizard();
    await send('I follow Formula 1 racing');
    expect(menuCount()).toBe(0);
    expect(screen.getByPlaceholderText(copy.placeholderHome)).toBeTruthy();

    await press('fact-choice-add-0');

    await waitForMenus(1);
    expect(rows()[rows().length - 1]).toBe(copy.whatNext);
    expect(screen.getByPlaceholderText(copy.placeholderChoose)).toBeTruthy();
    expect(screen.queryByTestId('onboarding-chip-privacy')).toBeNull();
    expect(screen.queryByTestId('onboarding-chip-decline')).toBeNull();
  });

  it('typing at the menu is an ordinary turn and stays at the menu', async () => {
    await toMenu();
    const before = modelCalls().length;

    await send('What is new today?');

    expect(isRouteLeg(modelCalls()[before])).toBe(true);
    expect(screen.getByPlaceholderText(copy.placeholderChoose)).toBeTruthy();
    expect(screen.queryByTestId('onboarding-chip-something-else')).toBeNull();
  });

  it('a chip waits while a reply is streaming', async () => {
    await toMenu();
    await press('onboarding-path-profile');
    await screen.findByTestId('onboarding-chip-something-else');

    await act(async () => {
      useCloudChatStore.setState({ status: 'streaming' });
    });
    expect(screen.queryByTestId('onboarding-chip-something-else')).toBeNull();

    await act(async () => {
      useCloudChatStore.setState({ status: 'idle' });
    });
    expect(screen.getByTestId('onboarding-chip-something-else')).toBeTruthy();
  });
});

describe('a menu option', () => {
  it('Create my profile adds the option and the explanation with no model call', async () => {
    await toMenu();
    const before = modelCalls().length;

    await press('onboarding-path-profile');

    await screen.findByPlaceholderText(copy.composerPlaceholder);
    expect(rows().slice(-2)).toEqual([copy.pathProfile, copy.profileExplain]);
    expect(modelCalls()).toHaveLength(before);
    expect(screen.getByTestId('onboarding-chip-decline')).toBeTruthy();
    expect(screen.getByTestId('onboarding-chip-something-else')).toBeTruthy();
  });

  it('Follow a story adds its line, and the answer reaches the follow card with no route leg, for one turn', async () => {
    await toMenu();
    const before = modelCalls().length;

    await press('onboarding-path-follow');
    await screen.findByPlaceholderText(copy.placeholderFollow);
    expect(rows().slice(-2)).toEqual([copy.pathFollow, copy.followExplain]);
    expect(modelCalls()).toHaveLength(before);

    await send('Ukraine war');
    await screen.findByTestId('track-card');
    const forced = modelCalls()[before];
    expect(isRouteLeg(forced)).toBe(false);
    expect(forced.messages.some((m) => m.content === 'Ukraine war')).toBe(true);

    const after = modelCalls().length;
    await send('What is new today?');
    expect(isRouteLeg(modelCalls()[after])).toBe(true);
  });

  it('Tell me about Mera is a real, visible turn', async () => {
    await toMenu();
    const before = modelCalls().length;

    await press('onboarding-path-about');
    await turnOver();

    expect(rows()).toContain(copy.pathAbout);
    expect(personMessage(modelCalls()[before])).toBe(copy.pathAbout);
    expect(screen.getByPlaceholderText(copy.placeholderAbout)).toBeTruthy();
  });

  it('the settled follow card leaves no way out of the wizard', async () => {
    await toMenu();
    await press('onboarding-path-follow');
    await screen.findByPlaceholderText(copy.placeholderFollow);
    await send('Ukraine war');
    await press('track-follow');

    await screen.findByTestId('track-card-followed', {}, { timeout: 10_000 });
    expect(screen.queryByTestId('track-see-followed')).toBeNull();
  });
});

describe('Want to do something else?', () => {
  it.each(['profile', 'follow', 'about'] as const)('brings all three options back from %s with no model call', async (path) => {
    await toMenu();
    await press(`onboarding-path-${path}`);
    await screen.findByTestId('onboarding-chip-something-else');
    await turnOver();
    const before = modelCalls().length;
    const kept = rows().length;

    await press('onboarding-chip-something-else');

    await waitForMenus(2);
    expect(rows().slice(kept)).toEqual([copy.whatNext]);
    expect(modelCalls()).toHaveLength(before);
    expect(screen.getAllByTestId('onboarding-path-profile')).toHaveLength(2);
    expect(screen.getAllByTestId('onboarding-path-follow')).toHaveLength(2);
    expect(screen.getAllByTestId('onboarding-path-about')).toHaveLength(2);
    expect(screen.getByPlaceholderText(copy.placeholderChoose)).toBeTruthy();
    expect(screen.queryByTestId('onboarding-chip-something-else')).toBeNull();
  });

  it('drops a pending follow: the next message is routed, never treated as a story', async () => {
    await toMenu();
    await press('onboarding-path-follow');
    await screen.findByTestId('onboarding-chip-something-else');
    await press('onboarding-chip-something-else');
    await waitForMenus(2);
    const before = modelCalls().length;

    await send('What is new today?');

    expect(isRouteLeg(modelCalls()[before])).toBe(true);
  });
});

describe('check marks', () => {
  const { pathProfile, pathFollow, pathAbout } = copy;

  it('every option starts open, and Set location asks where they live with no model call', async () => {
    await openWizard();
    await press('onboarding-chip-decline');
    await waitForMenus(1);
    for (const path of ['location', 'profile', 'follow', 'about']) {
      expect(screen.getByTestId(`onboarding-path-${path}-open`, { includeHiddenElements: true })).toBeTruthy();
    }

    await press('onboarding-path-location');

    expect(rows()).toEqual([copy.ratherNotSay, copy.whatNext, 'Set location', 'Where do you live?']);
    expect(modelCalls()).toHaveLength(0);
    expect(screen.getByTestId('onboarding-chip-decline')).toBeTruthy();
    expect(screen.getByTestId('onboarding-chip-something-else')).toBeTruthy();
  });

  it('a location ticks Set location, and only another fact ticks Create my profile', async () => {
    await openWizard();
    await press('onboarding-chip-decline');
    await waitForMenus(1);

    await act(async () => {
      await addFact('Lives in Delft', undefined, { attribute: CANONICAL_LOCATION_KEY });
    });
    await waitFor(() => expect(label('onboarding-path-location')).toBe('Set location, done'));
    expect(screen.getByTestId('onboarding-path-location-done', { includeHiddenElements: true })).toBeTruthy();
    expect(label('onboarding-path-profile')).toBe(pathProfile);

    await act(async () => {
      await addFact('Works as a nurse');
    });
    await waitFor(() => expect(label('onboarding-path-profile')).toBe(`${pathProfile}, done`));
  });

  it('a followed story ticks Follow a story, on every menu in the thread', async () => {
    await toMenu();
    await press('onboarding-path-profile');
    await press('onboarding-chip-something-else');
    await waitForMenus(2);

    await act(async () => {
      await trackStory({ title: 'Ukraine war', topicText: 'ukraine war' } as never);
    });

    await waitFor(() => expect(label('onboarding-path-follow', 0)).toBe(`${pathFollow}, done`));
    expect(label('onboarding-path-follow', 1)).toBe(`${pathFollow}, done`);
  });

  it('Tell me about Mera ticks once tapped, and stays tappable', async () => {
    await toMenu();
    await press('onboarding-path-about');
    await turnOver();
    await press('onboarding-chip-something-else');
    await waitForMenus(2);

    expect(label('onboarding-path-about', 0)).toBe(`${pathAbout}, done`);
    expect(label('onboarding-path-about', 1)).toBe(`${pathAbout}, done`);
    await act(async () => {
      fireEvent.press(screen.getAllByTestId('onboarding-path-about')[1]);
    });
    await turnOver();
    expect(rows().filter((r) => r === pathAbout)).toHaveLength(2);
  });
});

describe('the Ready badge on the real ping', () => {
  const stepLabel = () => screen.getByTestId('onboarding-step-label').props.accessibilityLabel;

  it('warms until the ping answers, then reads Ready', async () => {
    server.use(...mockGateway((c) => (isPing(c) ? { chunks: ['ready'], headerDelayMs: 1500 } : responder(c))));
    await openWizard();

    await waitFor(() => expect(stepLabel()).toBe(`Step 1 of 3, ${en.chat.statusWarming}`), { timeout: 10_000 });
    await waitFor(() => expect(stepLabel()).toBe(`Step 1 of 3, ${en.chat.statusReady}`), { timeout: 15_000 });
  });

  it('shows the error state when the ping fails', async () => {
    server.use(...mockGateway((c) => (isPing(c) ? { status: 400, body: { error: 'nope' } } : responder(c))));
    await openWizard();

    await waitFor(() => expect(stepLabel()).toBe(`Step 1 of 3, ${en.chat.statusError}`), { timeout: 15_000 });
  });
});

describe('the Ready badge', () => {
  let ping: jest.SpyInstance;
  const badge = () => screen.queryByTestId('chat-header-readiness', { includeHiddenElements: true });
  const stepLabel = () => screen.getByTestId('onboarding-step-label').props.accessibilityLabel;
  const status = (s: prewarm.ChatReadiness) =>
    act(async () => {
      prewarm.useChatReadiness.setState({ status: s });
    });

  beforeEach(() => {
    ping = jest.spyOn(prewarm, 'prewarmCloudChat').mockImplementation(() => {});
  });
  afterEach(() => ping.mockRestore());

  it('goes from warming to Ready to the error state, and the header says so', async () => {
    await openWizard();
    expect(badge()).toBeNull();
    expect(stepLabel()).toBe('Step 1 of 3');

    await status('warming');
    expect(badge()).toBeTruthy();
    expect(stepLabel()).toBe(`Step 1 of 3, ${en.chat.statusWarming}`);

    await status('ready');
    expect(stepLabel()).toBe(`Step 1 of 3, ${en.chat.statusReady}`);

    await status('error');
    expect(stepLabel()).toBe(`Step 1 of 3, ${en.chat.statusError}`);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('hides on the later steps', async () => {
    await openWizard();
    await status('ready');
    await press('onboarding-next');
    await screen.findByTestId('onboarding-sources-step');
    expect(badge()).toBeNull();
    expect(stepLabel()).toBe('Step 2 of 3');
  });

  it('hides for a blocked account', async () => {
    await openWizard();
    await status('ready');
    expect(badge()).toBeTruthy();

    await act(async () => {
      useCloudChatStore.setState({ isBlocked: true });
    });

    expect(badge()).toBeNull();
    expect(stepLabel()).toBe('Step 1 of 3');
  });

  it('hides on device', async () => {
    await setProcessingMode('on-device');
    await render(<OnboardingWizard userId={FIXTURE_ACCOUNT.userId} onComplete={jest.fn()} />);
    await screen.findByTestId('onboarding-cloud-only', {}, { timeout: 10_000 });
    await status('ready');

    expect(badge()).toBeNull();
  });
});
