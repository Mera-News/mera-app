// The wizard's Next past step 1 (the fact gate itself is onboarding-fact-gate.test.tsx).
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import OnboardingWizard from '@/components/custom/onboarding/OnboardingWizard';
import { AccountService } from '@/lib/account-service';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { OnboardingStage } from '@/lib/generated/graphql-types';
import * as notificationService from '@/lib/notification-service';
import { useNetworkStore } from '@/lib/stores/network-store';
import { graphql, HttpResponse, initI18nEn, server } from '@/test/helpers';

// The kit Modal needs its overlay host; what the wizard decides is in these props.
jest.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({ open, title, confirmLabel, cancelLabel, onConfirm, onCancel }: Record<string, any>) => {
    const { Pressable, Text } = jest.requireActual('react-native');
    if (!open) return null;
    return (
      <>
        <Text>{title}</Text>
        <Pressable onPress={onConfirm}><Text>{confirmLabel}</Text></Pressable>
        {onCancel ? <Pressable onPress={onCancel}><Text>{cancelLabel}</Text></Pressable> : null}
      </>
    );
  },
}));
jest.mock('react-native-keyboard-controller', () => ({
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const { View } = jest.requireActual('react-native');
  return { __esModule: true, default: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? <View>{children}</View> : null) };
});
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/onboarding/PersonaUpdateChatStep', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-mera/NotificationSettingsScreen', () => ({ __esModule: true, default: () => null }));

const open = async () => {
  await render(<OnboardingWizard userId="user-1" onComplete={jest.fn()} />);
  await screen.findByTestId('onboarding-next');
};

/** The sources step is skippable and writes no stage. */
const skipSources = async () => {
  await screen.findByTestId('onboarding-sources-step');
  await fireEvent.press(screen.getByTestId('onboarding-next'));
  await screen.findByTestId('onboarding-remind');
};

let advanceStage: jest.SpyInstance;
beforeAll(initI18nEn);
beforeEach(() => {
  advanceStage = jest.spyOn(AccountService, 'advanceOnboardingStage').mockResolvedValue(undefined as never);
});
afterEach(() => advanceStage.mockRestore());

it('finishing does not wait for the push token', async () => {
  await addFact('I follow Formula 1 racing');
  jest.spyOn(notificationService, 'ensurePushTokenRegistered').mockReturnValue(new Promise(() => {}));
  const onComplete = jest.fn();
  await render(<OnboardingWizard userId="user-1" onComplete={onComplete} />);
  await waitFor(() => expect(screen.getByTestId('onboarding-next').props.accessibilityState?.disabled).toBeFalsy());
  await fireEvent.press(await screen.findByTestId('onboarding-next'));
  await skipSources();

  await fireEvent.press(screen.getByTestId('onboarding-next'));
  await fireEvent.press(await screen.findByTestId('onboarding-guard-notifications-secondary'));

  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
});

it('Next with a fact goes straight to the sources step', async () => {
  await addFact('I follow Formula 1 racing');
  await open();
  await waitFor(() => expect(screen.getByTestId('onboarding-next').props.accessibilityState?.disabled).toBeFalsy());

  await fireEvent.press(screen.getByTestId('onboarding-next'));

  await waitFor(() => expect(advanceStage).toHaveBeenCalledWith('user-1', OnboardingStage.PersonaChat));
  expect(await screen.findByTestId('onboarding-sources-step')).toBeTruthy();
});

describe('Next when the server does not answer', () => {
  const toNotifications = async () => {
    await addFact('I follow Formula 1 racing');
    await open();
    await waitFor(() => expect(screen.getByTestId('onboarding-next').props.accessibilityState?.disabled).toBeFalsy());
    await fireEvent.press(screen.getByTestId('onboarding-next'));
    await skipSources();
  };
  const finish = async () => {
    await fireEvent.press(screen.getByTestId('onboarding-next'));
    await fireEvent.press(await screen.findByTestId('onboarding-guard-notifications-secondary'));
  };
  const graphqlError = (code: string, statusCode: number) =>
    new CombinedGraphQLErrors({ errors: [{ message: 'no', extensions: { code, statusCode } }] });

  afterEach(() => useNetworkStore.setState({ isConnected: true }));

  it('step 0 moves on offline: its stage write decides nothing', async () => {
    useNetworkStore.setState({ isConnected: false });

    await toNotifications();

    expect(screen.queryByText('Connection Issue')).toBeNull();
  });

  it('step 0 moves on when its stage write fails, with no dialog', async () => {
    advanceStage.mockRejectedValue(graphqlError('INTERNAL_SERVER_ERROR', 500));

    await toNotifications();

    expect(screen.queryByText('Connection Issue')).toBeNull();
  });

  it.each([
    ['offline', () => useNetworkStore.setState({ isConnected: false })],
    ['a failing stage write', () => advanceStage.mockRejectedValue(graphqlError('INTERNAL_SERVER_ERROR', 500))],
    ['a refused session', () => advanceStage.mockRejectedValue(graphqlError('UNAUTHENTICATED', 401))],
  ])('the last step completes with %s and offers neither a dialog nor Log out', async (_name, breakIt) => {
    const onComplete = jest.fn();
    await addFact('I follow Formula 1 racing');
    await render(<OnboardingWizard userId="user-1" onComplete={onComplete} />);
    await waitFor(() => expect(screen.getByTestId('onboarding-next').props.accessibilityState?.disabled).toBeFalsy());
    await fireEvent.press(screen.getByTestId('onboarding-next'));
    await skipSources();
    breakIt();

    await finish();

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Connection Issue')).toBeNull();
    expect(screen.queryByText('Logout')).toBeNull();
  });
});
