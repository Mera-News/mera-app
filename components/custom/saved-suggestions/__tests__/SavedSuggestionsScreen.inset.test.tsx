/* eslint-disable @typescript-eslint/no-require-imports */
// Batch 11: on the Saved tab the info note sat inset from the screen edges
// while the saved cards ran edge to edge. The cards take the note's inset.
jest.mock('react-native-css-interop/jsx-runtime', () => {
  const R = require('react/jsx-runtime');
  return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const R = require('react/jsx-dev-runtime');
  return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
const mockScrollToOffset = jest.fn();
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = jest.requireActual('react-native');
  // Renders the header and the rows, so the test can compare their insets.
  const FlatList = ReactLib.forwardRef(
    ({ data, renderItem, ListHeaderComponent, ...rest }: any, _ref: any) =>
      ReactLib.createElement(
        View,
        rest,
        ListHeaderComponent,
        (data ?? []).map((item: any, index: number) =>
          ReactLib.createElement(ReactLib.Fragment, { key: index }, renderItem({ item, index })),
        ),
      ),
  );
  return { __esModule: true, default: { FlatList, View } };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (cb: any) => require('react').useEffect(cb, [cb]),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/components/ui/toast', () => ({
  useToast: () => ({ show: jest.fn() }),
  Toast: () => null,
  ToastTitle: () => null,
  ToastDescription: () => null,
}));
jest.mock('@/components/custom/cards/ArticleSuggestionCard', () => ({ ArticleSuggestionCard: () => null }));
jest.mock('@/components/custom/cards/ArticleStandaloneCard', () => ({ ArticleStandaloneCard: () => null }));
jest.mock('@/components/ui/button', () => ({ Button: () => null, ButtonText: () => null }));
jest.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
jest.mock('@/components/ui/modal', () => ({
  Modal: () => null,
  ModalBackdrop: () => null,
  ModalBody: () => null,
  ModalContent: () => null,
  ModalFooter: () => null,
  ModalHeader: () => null,
}));
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
  loadSavedItems: () =>
    Promise.resolve([{ origin: 'suggestion', suggestion: { _id: 's1', articleId: 'a1', title_en: 'West Nile' } }]),
  deleteSavedSuggestion: jest.fn(),
}));
jest.mock('../SavedExportModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../SavedExportFab', () => ({ __esModule: true, default: () => null, SAVED_EXPORT_FAB_RESERVE: 82 }));
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => ({ __esModule: true, default: () => null }));

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import SavedSuggestionsScreen from '../SavedSuggestionsScreen';

describe('SavedSuggestionsScreen inset', () => {
  it('insets every saved card like the info note above it', async () => {
    const r = render(<SavedSuggestionsScreen embedded onBack={jest.fn()} headerHeight={0} />);
    await waitFor(() => r.getByTestId('saved-item-s1'));
    // The composite Box nodes carry the className (the host View does not).
    const withClass = (pred: (p: any) => boolean) =>
      r.UNSAFE_root.findAll((n: any) => typeof n.props?.className === 'string' && pred(n.props))[0];
    const row = withClass((p) => p.testID === 'saved-item-s1');
    const note = withClass((p) => p.accessibilityRole === 'summary');
    const inset = (cls: string) => (String(cls).match(/\bmx-\d+\b/) ?? [''])[0];
    expect(inset(note.props.className)).toBe('mx-4');
    expect(inset(row.props.className)).toBe(inset(note.props.className));
  });
});
