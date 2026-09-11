// SubscriptionsSection — the properties that are product decisions, not styling.
//
//   1. THE SECTION ALWAYS RENDERS, empty or not. It is how the feature is
//      discovered; one that appears only once you already use it cannot be
//      found.
//   2. A PUBLISHER WITH NO subscription_uri GETS NO BROWSER STEP. There is no
//      page to send them to, so offering a dead "Subscribe" affordance would be
//      a link to nowhere.
//   3. THE PROMPT IS ARMED BY A RETURN FROM BACKGROUND, not by the browser
//      result: expo-web-browser resolves {type:'opened'} immediately on Android
//      and cancel/dismiss are iOS-only.
//   4. A DISMISS COUNTS AS NO, and a No is persisted so the prompt never fires
//      for that publisher again.
//   5. EVERY CONTROL IS LABELLED, and the remove control names its publisher.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

let returnFromBackground: (() => void) | null = null;
const mockOpenSubscribePage = jest.fn(async (_uri: string) => true);
jest.mock('@/lib/subscriptions/subscribe-flow', () => ({
  openSubscribePage: (uri: string) => mockOpenSubscribePage(uri),
  onReturnFromBackground: (cb: () => void) => {
    returnFromBackground = cb;
    return () => {
      returnFromBackground = null;
    };
  },
}));

const mockAdd = jest.fn(async () => true);
const mockRemove = jest.fn(async () => true);
const mockDecline = jest.fn(async () => undefined);
const mockHasAnswered = jest.fn(async () => false);
let mockItems: any[] = [];
let mockLoading = false;
jest.mock('../use-subscriptions', () => ({
  useSubscriptions: () => ({
    items: mockItems,
    isLoading: mockLoading,
    busyId: null,
    addSubscription: mockAdd,
    removeSubscription: mockRemove,
    declineSubscription: mockDecline,
    hasAnsweredForPublisher: mockHasAnswered,
  }),
}));

// The picker's own states are covered by its own suite; here it is reduced to
// a button that hands back a chosen publisher.
let mockChosenFixture: any = {
  publisherId: 'pub1',
  publisherName: 'Het Parool',
  countryCode: 'NLD',
  subscriptionUri: 'https://www.parool.nl/abonnementen',
};
jest.mock('../AddSubscriptionView', () => {
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ onChoose }: { onChoose: (p: any) => void }) => (
      <Pressable testID="choose" onPress={() => onChoose(mockChosenFixture)}>
        <Text>choose</Text>
      </Pressable>
    ),
  };
});

// --- gluestack ui + icons -> RN primitives --------------------------------
// Mapped to plain RN views rather than rendered for real. components/ui/button
// reaches ActivityIndicator, which jest-expo mis-transforms, and the modal
// primitives pull the same graph. The sibling PublicationPreferencesScreen
// suite does the equivalent for ScrollView.
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View testID="spinner" {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    Button: (p: any) => <Pressable {...p} />,
    ButtonText: ({ children }: any) => <Text>{children}</Text>,
  };
});
jest.mock('@/components/ui/modal', () => {
  const { View } = require('react-native');
  const Pass = ({ children, ...rest }: any) => <View {...rest}>{children}</View>;
  return {
    Modal: ({ isOpen, children, ...rest }: any) => (isOpen ? <View {...rest}>{children}</View> : null),
    ModalBackdrop: () => null,
    ModalContent: Pass,
    ModalHeader: Pass,
    ModalBody: Pass,
    ModalFooter: Pass,
  };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/locations/location-display', () => ({
  flagForAlpha2: () => 'FLAG',
  alpha3ToAlpha2: (a: string) => a,
}));

jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/toast-manager', () => ({
  toastManager: { showInfo: jest.fn(), showSuccess: jest.fn() },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o?.publisher ? `${k}:${String(o.publisher)}` : k,
  }),
}));

import SubscriptionsSection from '../SubscriptionsSection';

function sub(over: Record<string, any> = {}) {
  return {
    id: 'row1',
    publisherId: 'pub1',
    publisherName: 'Het Parool',
    publisherNameNorm: 'het parool',
    countryCode: 'NLD',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockItems = [];
  mockLoading = false;
  returnFromBackground = null;
  mockChosenFixture = {
    publisherId: 'pub1',
    publisherName: 'Het Parool',
    countryCode: 'NLD',
    subscriptionUri: 'https://www.parool.nl/abonnementen',
  };
  mockOpenSubscribePage.mockResolvedValue(true);
  mockHasAnswered.mockResolvedValue(false);
});

describe('the section itself', () => {
  it('renders its heading and empty state when there are no subscriptions', () => {
    const { getByText } = render(<SubscriptionsSection />);
    expect(getByText('subscriptions.sectionTitle')).toBeTruthy();
    expect(getByText('subscriptions.empty')).toBeTruthy();
  });

  it('lists active subscriptions', () => {
    mockItems = [sub(), sub({ id: 'row2', publisherName: 'AD.nl', publisherId: 'pub2' })];
    const { getByText } = render(<SubscriptionsSection />);
    expect(getByText('Het Parool')).toBeTruthy();
    expect(getByText('AD.nl')).toBeTruthy();
  });

  it('labels the add control and names the publisher on each remove control', () => {
    mockItems = [sub()];
    const { getByLabelText } = render(<SubscriptionsSection />);
    expect(getByLabelText('subscriptions.add')).toBeTruthy();
    expect(getByLabelText('subscriptions.removeA11y:Het Parool')).toBeTruthy();
  });

  it('removes a subscription', async () => {
    mockItems = [sub()];
    const { getByLabelText } = render(<SubscriptionsSection />);
    fireEvent.press(getByLabelText('subscriptions.removeA11y:Het Parool'));
    await waitFor(() => expect(mockRemove).toHaveBeenCalled());
  });
});

describe('choosing a publisher WITH a subscription_uri', () => {
  it('opens the subscribe page and does not prompt yet', async () => {
    const { getByLabelText, getByTestId, queryByText } = render(<SubscriptionsSection />);
    fireEvent.press(getByLabelText('subscriptions.add'));
    fireEvent.press(getByTestId('choose'));

    await waitFor(() => expect(mockOpenSubscribePage).toHaveBeenCalledTimes(1));
    expect(queryByText('subscriptions.confirmYes')).toBeNull();
  });

  it('prompts only after the return from background', async () => {
    const { getByLabelText, getByTestId, findByText } = render(<SubscriptionsSection />);
    fireEvent.press(getByLabelText('subscriptions.add'));
    fireEvent.press(getByTestId('choose'));
    await waitFor(() => expect(mockOpenSubscribePage).toHaveBeenCalled());

    returnFromBackground?.();
    expect(await findByText('subscriptions.confirmYes')).toBeTruthy();
  });

  it('adds the subscription on Yes', async () => {
    const { getByLabelText, getByTestId, findByText } = render(<SubscriptionsSection />);
    fireEvent.press(getByLabelText('subscriptions.add'));
    fireEvent.press(getByTestId('choose'));
    await waitFor(() => expect(mockOpenSubscribePage).toHaveBeenCalled());
    returnFromBackground?.();

    fireEvent.press(await findByText('subscriptions.confirmYes'));
    await waitFor(() =>
      expect(mockAdd).toHaveBeenCalledWith(
        expect.objectContaining({ publisherId: 'pub1' }),
      ),
    );
  });

  it('persists a decline on No, so the prompt never fires again', async () => {
    const { getByLabelText, getByTestId, findByText } = render(<SubscriptionsSection />);
    fireEvent.press(getByLabelText('subscriptions.add'));
    fireEvent.press(getByTestId('choose'));
    await waitFor(() => expect(mockOpenSubscribePage).toHaveBeenCalled());
    returnFromBackground?.();

    fireEvent.press(await findByText('subscriptions.confirmNo'));
    await waitFor(() => expect(mockDecline).toHaveBeenCalled());
    expect(mockAdd).not.toHaveBeenCalled();
  });

  // Between leaving and coming back the user may have added or declined this
  // publisher another way. Asking again is asking a question already answered.
  it('does not prompt when the publisher has since been answered', async () => {
    mockHasAnswered.mockResolvedValue(true);
    const { getByLabelText, getByTestId, queryByText } = render(<SubscriptionsSection />);
    fireEvent.press(getByLabelText('subscriptions.add'));
    fireEvent.press(getByTestId('choose'));
    await waitFor(() => expect(mockOpenSubscribePage).toHaveBeenCalled());

    returnFromBackground?.();
    await waitFor(() => expect(mockHasAnswered).toHaveBeenCalled());
    expect(queryByText('subscriptions.confirmYes')).toBeNull();
  });
});

describe('choosing a publisher with NO subscription_uri', () => {
  beforeEach(() => {
    mockChosenFixture = { ...mockChosenFixture, publisherId: 'tnw', publisherName: 'The Next Web', subscriptionUri: null };
  });

  // The Next Web and Free Press Journal are the real rows behind this case.
  it('never opens a browser and asks directly', async () => {
    const { getByLabelText, getByTestId, findByText } = render(<SubscriptionsSection />);
    fireEvent.press(getByLabelText('subscriptions.add'));
    fireEvent.press(getByTestId('choose'));

    expect(await findByText('subscriptions.confirmYes')).toBeTruthy();
    expect(mockOpenSubscribePage).not.toHaveBeenCalled();
  });
});

describe('when the subscribe page cannot be opened', () => {
  it('falls back to asking directly rather than dead-ending', async () => {
    mockOpenSubscribePage.mockResolvedValue(false);
    const { getByLabelText, getByTestId, findByText } = render(<SubscriptionsSection />);
    fireEvent.press(getByLabelText('subscriptions.add'));
    fireEvent.press(getByTestId('choose'));

    expect(await findByText('subscriptions.confirmYes')).toBeTruthy();
  });
});
