/* eslint-disable @typescript-eslint/no-require-imports */
// The Library's Saved page layout: the export row pinned under the header
// (only with rows), the list padded below header and row, cards inset like the
// row, and the list end and footer handed over by the host.
jest.mock('react-native-css-interop/jsx-runtime', () => {
  const R = require('react/jsx-runtime');
  return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const R = require('react/jsx-dev-runtime');
  return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = jest.requireActual('react-native');
  // Renders every slot the screen uses, so presence and absence both count.
  const FlatList = ReactLib.forwardRef(
    ({ data, renderItem, ListEmptyComponent, ListFooterComponent, ...rest }: any, _ref: any) =>
      ReactLib.createElement(
        View,
        rest,
        (data ?? []).length
          ? (data ?? []).map((item: any, index: number) =>
              ReactLib.createElement(ReactLib.Fragment, { key: index }, renderItem({ item, index })),
            )
          : ListEmptyComponent,
        ListFooterComponent,
      ),
  );
  return { __esModule: true, default: { FlatList, View } };
});
let mockRows: unknown[] = [];
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
jest.mock('../SavedExportRow', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID="saved-export-row" {...p} />, SAVED_EXPORT_ROW_HEIGHT: 56 };
});
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => ({ __esModule: true, default: () => null }));

import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';
import SavedSuggestionsScreen from '../SavedSuggestionsScreen';

const suggestion = (id: string) => ({ origin: 'suggestion', suggestion: { _id: id, articleId: `a-${id}`, title_en: id } });
const listStyle = () => screen.getByTestId('saved-suggestions-list').props.contentContainerStyle;

beforeEach(() => {
  mockRows = [];
});

describe('SavedSuggestionsScreen layout', () => {
  it('pins the export row under the header with the count, and pads the list below both', async () => {
    mockRows = [suggestion('s1'), suggestion('s2')];
    render(<SavedSuggestionsScreen headerHeight={120} />);
    await act(async () => {});
    const row = screen.getByTestId('saved-export-row');
    expect(row.props.count).toBe(2);
    expect(row.props.headerHeight).toBe(120);
    expect(listStyle().paddingTop).toBe(120 + 56 + 12);
  });

  it('has no export row and no row padding when nothing is saved', async () => {
    render(<SavedSuggestionsScreen headerHeight={120} />);
    await act(async () => {});
    expect(screen.queryByTestId('saved-export-row')).toBeNull();
    expect(listStyle().paddingTop).toBe(120 + 12);
  });

  it('insets every card like the export row (mx-4 is 14pt, the row pads 14)', async () => {
    mockRows = [suggestion('s1')];
    const r = render(<SavedSuggestionsScreen headerHeight={0} />);
    await act(async () => {});
    const card = r.UNSAFE_root.findAll(
      (n: any) => n.props?.testID === 'saved-item-s1' && typeof n.props?.className === 'string',
    )[0];
    expect(String(card.props.className)).toMatch(/\bmx-4\b/);
  });

  it("takes the host's list-end clearance and footer", async () => {
    mockRows = [suggestion('s1')];
    render(<SavedSuggestionsScreen headerHeight={0} listEndPadding={172} footer={<Text testID="how-row" />} />);
    await act(async () => {});
    expect(listStyle().paddingBottom).toBe(172);
    expect(screen.getByTestId('how-row')).toBeTruthy();
  });
});
