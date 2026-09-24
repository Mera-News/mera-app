/* eslint-disable @typescript-eslint/no-require-imports */
// Captured on device: after deletes left two saved rows, the list kept its old
// scroll offset, so the first row's delete button sat at y=198pt under the
// 211pt Dashboard header, and with nothing left to scroll the reader could not
// bring it back. A list whose content now fits must settle to the top.
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
  const FlatList = ReactLib.forwardRef(
    ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ...rest }: any, ref: any) => {
      ReactLib.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset }));
      return ReactLib.createElement(View, rest);
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
  loadSavedItems: () => Promise.resolve([]),
  deleteSavedSuggestion: jest.fn(),
}));
jest.mock('../SavedExportModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../SavedExportFab', () => ({ __esModule: true, default: () => null, SAVED_EXPORT_FAB_RESERVE: 82 }));
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => ({ __esModule: true, default: () => null }));

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import SavedSuggestionsScreen from '../SavedSuggestionsScreen';

beforeEach(() => mockScrollToOffset.mockClear());

describe('SavedSuggestionsScreen scroll settle', () => {
  it('scrolls back to the top when the content now fits the viewport', () => {
    render(<SavedSuggestionsScreen embedded onBack={jest.fn()} headerHeight={211} />);
    const list = screen.getByTestId('saved-suggestions-list');
    fireEvent(list, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 402, height: 790 } } });
    fireEvent(list, 'contentSizeChange', 402, 620);
    expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  });

  it('leaves a long list where the reader is', () => {
    render(<SavedSuggestionsScreen embedded onBack={jest.fn()} headerHeight={211} />);
    const list = screen.getByTestId('saved-suggestions-list');
    fireEvent(list, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 402, height: 790 } } });
    fireEvent(list, 'contentSizeChange', 402, 2400);
    expect(mockScrollToOffset).not.toHaveBeenCalled();
  });
});
