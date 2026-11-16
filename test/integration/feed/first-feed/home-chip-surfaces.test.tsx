// The home chip on the Feed's zero-fact card and as World's leading row (D21): hidden once a home or any fact exists.
import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import { FeedNoFacts } from '@/components/custom/for-you/ForYouEmptyState';
import WorldHomeRow from '@/components/custom/world/WorldHomeRow';
import { addFact } from '@/lib/database/services/fact-service';
import { initI18nEn } from '@/test/helpers';

jest.mock('expo-localization', () => ({ getLocales: () => [{ regionCode: 'NL', languageTag: 'en-NL' }] }));
jest.mock('@/components/custom/feed/FeedShortcuts', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));

beforeAll(initI18nEn);

it('FeedNoFacts offers the chip with its hint', async () => {
  await render(<FeedNoFacts view="continuous" />);
  expect(await screen.findByTestId('home-country-chip')).toBeTruthy();
  expect(screen.getByText('Tell Mera where you live to start your feed.')).toBeTruthy();
  expect(screen.getByText('I live in the Netherlands')).toBeTruthy();
});

it('World row shows with zero facts and a country, with its line and the chip', async () => {
  await render(<WorldHomeRow />);
  expect(await screen.findByTestId('world-home-row')).toBeTruthy();
  expect(screen.getByText('Want news from where you live?')).toBeTruthy();
  expect(screen.getByTestId('world-home-chip')).toBeTruthy();
});

it('World row is gone once any fact exists', async () => {
  await addFact('I follow Formula 1 racing');
  await render(<WorldHomeRow />);
  await act(async () => {});
  expect(screen.queryByTestId('world-home-row')).toBeNull();
});

describe('counts card lead with a place but no facts', () => {
  it('is not the no-facts state', async () => {
    const { renderHook } = require('@testing-library/react-native');
    const { upsertLocation } = require('@/lib/database/services/location-service');
    const { useHasFactsOrPlaces } = require('@/components/custom/for-you/use-has-facts-or-places');
    await upsertLocation({ countryCode: 'NL', role: 'other' });
    const { result } = await renderHook(() => useHasFactsOrPlaces());
    await act(async () => {});
    expect(result.current).toBe(true);
  });
});
