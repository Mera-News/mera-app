/* eslint-disable @typescript-eslint/no-require-imports */
import { act, render } from '@testing-library/react-native';
import React from 'react';

// Replace FlatList with a lightweight synchronous list (the real one pulls in a
// native ScrollView component that doesn't resolve under jest, and virtualization
// is irrelevant to the client-side row-windowing this test exercises).
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const ReactLocal = require('react');
  const MockFlatList = ReactLocal.forwardRef((props: any, ref: any) => {
    const { data = [], renderItem, keyExtractor, ListHeaderComponent } = props;
    const header = ListHeaderComponent
      ? ReactLocal.isValidElement(ListHeaderComponent)
        ? ListHeaderComponent
        : ReactLocal.createElement(ListHeaderComponent)
      : null;
    return ReactLocal.createElement(
      RN.View,
      { ref },
      header,
      ...data.map((item: any, index: number) =>
        ReactLocal.createElement(
          ReactLocal.Fragment,
          { key: keyExtractor ? keyExtractor(item, index) : index },
          renderItem({ item, index }),
        ),
      ),
    );
  });
  // Proxy so RN's lazy getters are only evaluated on access (a naive spread
  // eagerly triggers every native-component getter, which throws under jest).
  return new Proxy(RN, {
    get(target, prop) {
      if (prop === 'FlatList') return MockFlatList;
      return target[prop];
    },
  });
});

import { FlatList } from 'react-native';

jest.mock('react-native-css-interop/jsx-runtime', () => {
  const ReactJSXRuntime = require('react/jsx-runtime');
  return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const ReactJSXRuntime = require('react/jsx-dev-runtime');
  return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

// Lightweight stand-ins for the heavy leaf components so the smoke test stays
// focused on the row-windowing behaviour.
jest.mock('@/components/custom/cards/ArticleSuggestionCompactCard', () => {
  const { View } = require('react-native');
  return { ArticleSuggestionCompactCard: (props: any) => <View testID={`card-${props.suggestion._id}`} /> };
});
jest.mock('@/components/custom/for-you/BreakingStrip', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="breaking" /> };
});
jest.mock('@/components/custom/for-you/FactSectionHeader', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => <Text testID="header">{props.title}</Text> };
});
jest.mock('@/components/custom/ScrollToTopFab', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="fab" /> };
});
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (props: any) => <View {...props} /> };
});
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/visibility-tick', () => ({ notifyScrollTick: jest.fn() }));
jest.mock('@/lib/navigation/tab-bar', () => ({ TAB_BAR_HEIGHT: 49 }));
jest.mock('@/lib/stores/opened-stories-store', () => ({
  useOpenedStoriesStore: (sel: any) => sel({ ids: new Set() }),
}));

import FactRowsFeed from '../FactRowsFeed';
import type { FactRow } from '@/lib/stores/fact-rows-selector';

function makeRow(i: number): FactRow {
  const s: any = { _id: `s${i}`, eventType: null };
  return {
    factId: `f${i}`,
    kind: 'fact',
    statement: `Fact ${i}`,
    factStatement: `Fact ${i}`,
    latestAddedMs: 1000 - i,
    groups: [{ data: s, members: [], rawScore: 0.5, bucket: 'MEDIUM', pubDateMs: 1000, addedMs: 1000 }],
  };
}

function outerList(root: ReturnType<typeof render>): any {
  // The vertical rows list is the only non-horizontal FlatList.
  return root.UNSAFE_getAllByType(FlatList).find((l: any) => !l.props.horizontal);
}

describe('FactRowsFeed row windowing', () => {
  it('renders only the first 3 rows initially', () => {
    const rows = Array.from({ length: 8 }, (_, i) => makeRow(i));
    const r = render(
      <FactRowsFeed breaking={[]} rows={rows} onPressSuggestion={jest.fn()} />,
    );
    expect(r.getAllByTestId('header')).toHaveLength(3);
  });

  it('reveals 3 more rows per onEndReached', () => {
    const rows = Array.from({ length: 8 }, (_, i) => makeRow(i));
    const r = render(
      <FactRowsFeed breaking={[]} rows={rows} onPressSuggestion={jest.fn()} />,
    );
    act(() => { outerList(r).props.onEndReached(); });
    expect(r.getAllByTestId('header')).toHaveLength(6);
    act(() => { outerList(r).props.onEndReached(); });
    // Caps at the row count (8), not 9.
    expect(r.getAllByTestId('header')).toHaveLength(8);
  });

  it('mounts the breaking strip when breaking items exist', () => {
    const breaking: any[] = [{ data: { _id: 'b1' }, members: [] }];
    const r = render(
      <FactRowsFeed breaking={breaking} rows={[makeRow(0)]} onPressSuggestion={jest.fn()} />,
    );
    expect(r.getByTestId('breaking')).toBeTruthy();
  });
});
