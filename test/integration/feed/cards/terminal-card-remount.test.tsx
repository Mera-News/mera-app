// The Feed footer swaps reading / end in place. Each variant must MOUNT fresh: a style that gains a CSS
// variable on a re-render trips react-native-css-interop's dev-only upgrade warning, which crashed the Feed
// ("Couldn't find a LinkingContext context"). Jest cannot see the warning, so this pins the cause: no instance
// survives a variant change.
import { render } from '@testing-library/react-native';
import React from 'react';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import { initI18nEn } from '@/test/helpers';

const mounts = { n: 0 };
jest.mock('@/components/custom/MeraLogo', () => {
  const { useEffect } = require('react');
  return () => {
    useEffect(() => {
      mounts.n += 1;
    }, []);
    return null;
  };
});

beforeAll(initI18nEn);

it('a variant change remounts the card instead of restyling it', async () => {
  mounts.n = 0;
  const view = await render(<AllCaughtUpCard />);
  expect(mounts.n).toBe(1);
  await view.rerender(<AllCaughtUpCard variant="end" />);
  expect(mounts.n).toBe(2);
});

it('the same variant keeps its instance', async () => {
  mounts.n = 0;
  const view = await render(<AllCaughtUpCard variant="end" />);
  await view.rerender(<AllCaughtUpCard variant="end" held />);
  expect(mounts.n).toBe(1);
});
