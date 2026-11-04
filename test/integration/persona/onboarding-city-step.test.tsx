// The required city step: placeSearch, its loading and failure states, manual entry when the server
// is unreachable, and the fact the step saves. Real services, real DB, the mock server.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import OnboardingCityStep from '@/components/custom/onboarding/OnboardingCityStep';
import * as factCommit from '@/lib/chat-tools/fact-commit';
import { getFacts } from '@/lib/database/services/fact-service';
import { getAll as getLocations } from '@/lib/database/services/location-service';
import { toastManager } from '@/lib/toast-manager';
import { graphql, HttpResponse, server } from '@/test/helpers';

jest.mock('react-native-keyboard-controller', () => ({
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));

const HOME_KEY = 'location: neighborhood/area, city, and country (preserve specifics)';
const delft = {
  __typename: 'Place',
  _id: 'p1',
  city: 'Delft',
  region: 'South Holland',
  countryCode: 'NL',
  displayName: 'Delft, South Holland, Netherlands',
  normalized: 'delft',
  population: 100,
  search_keys: ['delft'],
};
const answer = (places: unknown[]) => server.use(graphql.query('PlaceSearch', () => HttpResponse.json({ data: { placeSearch: places } })));
// Everything Mera serves is down: placeSearch and the old server country list alike.
const failServer = () => server.use(graphql.operation(() => HttpResponse.error()));

const openStep = async (onDone = jest.fn()) => {
  await render(<OnboardingCityStep onClose={jest.fn()} onDone={onDone} />);
  return onDone;
};
const search = async (text: string) => {
  await fireEvent.changeText(screen.getByPlaceholderText('locations.searchPlaceholder'), text);
};

it('says what the city is for', async () => {
  await openStep();
  expect(screen.getByText('onboarding.noFactsTitle')).toBeTruthy();
  expect(screen.getByText('onboarding.noFactsBody')).toBeTruthy();
});

it('the ask stays on the search step, so manual entry and its country list get the full height', async () => {
  failServer();
  await openStep();
  await search('del');
  await fireEvent.press(await screen.findByTestId('locations-add-manually'));

  expect(await screen.findByText('locations.cityLabel')).toBeTruthy();
  expect(screen.queryByText('onboarding.noFactsBody')).toBeNull();
});

it('the confirm step asks the same question, without the settings title', async () => {
  answer([delft]);
  await openStep();
  await search('del');
  await fireEvent.press(await screen.findByText('Delft, South Holland, Netherlands'));

  expect(await screen.findByText('onboarding.noFactsTitle')).toBeTruthy();
  expect(screen.queryByText('locations.addTitle')).toBeNull();
  expect(screen.queryByText('onboarding.noFactsBody')).toBeNull();
});

it('a picked place saves a home location and the residence fact, with no role or weight to choose', async () => {
  answer([delft]);
  const onDone = await openStep();
  await search('del');
  await fireEvent.press(await screen.findByText('Delft, South Holland, Netherlands'));

  expect(screen.queryByText('locations.weightLabel')).toBeNull();
  await fireEvent.press(screen.getByTestId('locations-save'));

  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  const [fact] = await getFacts();
  expect(fact.statement).toBe('Lives in Delft, South Holland, Netherlands');
  expect(fact.questionnaireAttribute).toBe(HOME_KEY);
  expect((await getLocations()).filter((l) => l.city === 'Delft' && l.role === 'home')).toHaveLength(1);
});

it('shows a loading state while the search runs', async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  server.use(
    graphql.query('PlaceSearch', async () => {
      await held;
      return HttpResponse.json({ data: { placeSearch: [delft] } });
    }),
  );
  await openStep();
  await search('del');

  expect(await screen.findByTestId('locations-searching')).toBeTruthy();
  await act(async () => release());
  await waitFor(() => expect(screen.queryByTestId('locations-searching')).toBeNull());
});

it('a failed search says so and keeps manual entry open, whose country list comes from the phone', async () => {
  failServer();
  const onDone = await openStep();
  await search('delft');

  expect(await screen.findByText('locations.searchUnavailable')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('locations-add-manually'));
  await fireEvent.changeText(screen.getByPlaceholderText('locations.cityPlaceholder'), 'delft');
  await fireEvent.press(screen.getByText('locations.selectCountry'));
  await fireEvent.changeText(screen.getByPlaceholderText('locations.searchCountries'), 'nether');
  await fireEvent.press(await screen.findByText('Netherlands'));
  await fireEvent.press(screen.getByText('common.next'));
  await fireEvent.press(screen.getByTestId('locations-save'));

  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect((await getFacts())[0].statement).toBe('Lives in Delft, Netherlands');
});

it('a save that fails stays on the step, tells the reader, and can be tried again', async () => {
  answer([delft]);
  const showError = jest.spyOn(toastManager, 'showError').mockImplementation(() => undefined as never);
  const commit = jest.spyOn(factCommit, 'commitFactChoices');
  commit.mockRejectedValueOnce(new Error('db locked'));
  const onDone = await openStep();
  await search('del');
  await fireEvent.press(await screen.findByText('Delft, South Holland, Netherlands'));
  await fireEvent.press(screen.getByTestId('locations-save'));

  await waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
  expect(onDone).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByTestId('locations-save'));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(await getFacts()).toHaveLength(1);
  commit.mockRestore();
  showError.mockRestore();
});
