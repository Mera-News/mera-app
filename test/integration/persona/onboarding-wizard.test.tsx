// The wizard's Next: zero facts asks for a city and never advances; a saved city moves on.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import OnboardingWizard from '@/components/custom/onboarding/OnboardingWizard';
import { AccountService } from '@/lib/account-service';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { OnboardingStage } from '@/lib/generated/graphql-types';
import { graphql, HttpResponse, server } from '@/test/helpers';

jest.mock('react-native-keyboard-controller', () => ({
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/onboarding/PersonaUpdateChatStep', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/config-mera/NotificationSettingsScreen', () => ({ __esModule: true, default: () => null }));

const open = async () => {
  await render(<OnboardingWizard userId="user-1" onComplete={jest.fn()} />);
  await screen.findByTestId('onboarding-next');
};

let advanceStage: jest.SpyInstance;
beforeEach(() => {
  advanceStage = jest.spyOn(AccountService, 'advanceOnboardingStage').mockResolvedValue(undefined as never);
});
afterEach(() => advanceStage.mockRestore());

it('Next with zero facts opens the city step, offers no skip and does not advance', async () => {
  await open();

  await fireEvent.press(screen.getByTestId('onboarding-next'));

  expect(screen.getByTestId('onboarding-city-step')).toBeTruthy();
  expect(screen.queryByTestId('onboarding-next')).toBeNull();
  expect(screen.queryByTestId('onboarding-guard-facts-secondary')).toBeNull();
  expect(advanceStage).not.toHaveBeenCalled();
});

it('a saved city writes the fact and moves on to notifications', async () => {
  server.use(
    graphql.query('PlaceSearch', () =>
      HttpResponse.json({
        data: { placeSearch: [{ __typename: 'Place', _id: 'p1', city: 'Delft', region: null, countryCode: 'NL', displayName: 'Delft, Netherlands', normalized: 'delft', population: 1, search_keys: [] }] },
      }),
    ),
  );
  await open();
  await fireEvent.press(screen.getByTestId('onboarding-next'));
  await fireEvent.changeText(screen.getByPlaceholderText('locations.searchPlaceholder'), 'del');
  await fireEvent.press(await screen.findByText('Delft, Netherlands'));
  await fireEvent.press(screen.getByTestId('locations-save'));

  await waitFor(() => expect(advanceStage).toHaveBeenCalledWith('user-1', OnboardingStage.PersonaChat));
  expect(screen.queryByTestId('onboarding-city-step')).toBeNull();
  expect((await getFacts()).map((f) => f.statement)).toEqual(['Lives in Delft, Netherlands']);
});

it('the close button goes back to the chat with nothing saved', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('onboarding-next'));

  await fireEvent.press(screen.getByLabelText('common.cancel', { includeHiddenElements: true }));

  expect(screen.queryByTestId('onboarding-city-step')).toBeNull();
  expect(screen.getByTestId('onboarding-next')).toBeTruthy();
});

it('Next with a fact goes straight to the notifications step', async () => {
  await addFact('I follow Formula 1 racing');
  await open();

  await fireEvent.press(screen.getByTestId('onboarding-next'));

  await waitFor(() => expect(advanceStage).toHaveBeenCalledWith('user-1', OnboardingStage.PersonaChat));
  expect(screen.queryByTestId('onboarding-city-step')).toBeNull();
});
