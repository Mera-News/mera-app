// The Feed's scoring progress is the header's bottom edge (owner): it shows while a run scores, over
// the real for-you store, and is gone when the pipeline is idle.
import { act, render } from '@testing-library/react-native';
import React from 'react';

import FeedHeaderProgress from '@/components/custom/feed/FeedHeaderProgress';
import { initI18nEn } from '@/test/helpers';
import { useForYouStore } from '@/lib/stores/for-you-store';

beforeAll(() => initI18nEn());
afterEach(() => {
  act(() => useForYouStore.setState({ batchProgress: null, asyncJobProcessedCount: 0, asyncJobTotalCount: 0 }));
});

describe('FeedHeaderProgress', () => {
  it('draws the run as a progress bar with its figures', () => {
    act(() => useForYouStore.setState({ batchProgress: { done: 412, total: 1000 } as never }));
    const { getByTestId } = render(<FeedHeaderProgress pageIndex={0} />);
    const bar = getByTestId('feed-header-progress');
    expect(bar.props.accessibilityRole).toBe('progressbar');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 1000, now: 412 });
  });

  it('draws nothing while no run scores', () => {
    const { queryByTestId } = render(<FeedHeaderProgress pageIndex={0} />);
    expect(queryByTestId('feed-header-progress')).toBeNull();
  });
});
