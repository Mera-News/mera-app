/* eslint-disable @typescript-eslint/no-require-imports */
// Captured (ux2 batch 28): the Saved tab exposed icon-font glyphs as their own
// StaticText, one per row (the delete button's glyph, inside the button) plus
// the info note's. The delete glyph is drawn beside a childless labelled
// button in the same circle; the info glyph is hidden.
jest.mock('react-native-css-interop/jsx-runtime', () => {
  const R = require('react/jsx-runtime');
  return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const R = require('react/jsx-dev-runtime');
  return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
const mockScrollToOffset = jest.fn();
let mockRows: any[] = [];
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = jest.requireActual('react-native');
  const FlatList = ReactLib.forwardRef(
    ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ...rest }: any, ref: any) => {
      ReactLib.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset }));
      // Renders the header and the rows, so their glyphs are in the tree.
      const header = typeof ListHeaderComponent === 'function' ? ReactLib.createElement(ListHeaderComponent) : ListHeaderComponent;
      return ReactLib.createElement(View, rest, header, ...(data ?? []).map((item: any, index: number) =>
        ReactLib.createElement(ReactLib.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index }))));
    },
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
  loadSavedItems: () => Promise.resolve(mockRows),
  deleteSavedSuggestion: jest.fn(),
}));
jest.mock('../SavedExportModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../SavedExportFab', () => ({ __esModule: true, default: () => null, SAVED_EXPORT_FAB_RESERVE: 82 }));
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => ({ __esModule: true, default: () => null }));

jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import { act, render } from '@testing-library/react-native';
import React from 'react';
import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';
import SavedSuggestionsScreen from '../SavedSuggestionsScreen';

const row = (id: string) => ({ origin: 'article', savedId: id, article: { _id: id }, savedAt: 1 });

it('exposes no icon glyph: the info note and every row\'s delete button', async () => {
  mockRows = [row('a1'), row('a2'), row('a3')];
  const r = render(<SavedSuggestionsScreen embedded onBack={jest.fn()} headerHeight={211} />);
  await act(async () => {});
  expect(r.getAllByTestId('saved-delete')).toHaveLength(3);
  expect(exposedGlyphTexts(r.UNSAFE_root)).toEqual([]);
  for (const b of r.getAllByTestId('saved-delete')) {
    expect(b.findAll((n: any) => n !== b && typeof n.type === 'string' && n.type !== 'View')).toHaveLength(0);
    expect(b.props.accessibilityLabel).toBe('savedSuggestions.deleteConfirmCta');
  }
});
