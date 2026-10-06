/* eslint-disable @typescript-eslint/no-require-imports */
// LibraryPages wires the four Library pages into the tab shell: pills in the
// reader's order, each page handed the shared header, the list-end clearance
// and its "How this page works" footer, Stats its arrival card, and ✓ saving
// the order.
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
let mockOrder = ['saved', 'checks', 'visited', 'stats'];
const mockSetPageOrder = jest.fn();
jest.mock('@/lib/navigation/page-order', () => ({
  usePageOrder: () => mockOrder,
  setPageOrder: (...a: unknown[]) => mockSetPageOrder(...a),
}));
jest.mock('@/lib/navigation/tab-bar', () => ({ useListEndClearance: () => 172 }));
jest.mock('@/components/custom/nav/page-registry', () => ({
  pageMeta: (id: string) => ({ labelKey: `nav.page.${id}` }),
}));
jest.mock('@/components/custom/nav/HowThisPageWorks', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID={`how-${p.pageId}`} /> };
});
const mockProps: Record<string, any> = {};
const capture = (name: string) =>
  function CapturedPage(p: any) {
    mockProps[name] = p;
    const { View } = require('react-native');
    return <View testID={`page-${name}`}>{p.footer}</View>;
  };
jest.mock('@/components/custom/saved-suggestions/SavedSuggestionsScreen', () => ({ __esModule: true, default: capture('saved') }));
jest.mock('@/components/custom/fact-checks/FactChecksPanel', () => ({ __esModule: true, default: capture('checks') }));
jest.mock('@/components/custom/config-panel/VisitedPublicationsList', () => ({ __esModule: true, default: capture('visited') }));
jest.mock('@/components/custom/share-stats/StatsPager', () => ({ __esModule: true, default: capture('stats') }));
let mockTabProps: any = null;
const mockHeader = { scrollHandler: jest.fn(), headerHeight: 106, hidden: { value: 0 }, reveal: jest.fn() };
jest.mock('@/components/custom/nav/TabPages', () => ({
  __esModule: true,
  default: (p: any) => {
    mockTabProps = p;
    const { View } = require('react-native');
    return (
      <View>
        {p.pages.map((pill: any) => (
          <View key={pill.id}>
            {p.renderPage({
              pageId: pill.id,
              active: pill.id === 'saved',
              header: mockHeader,
              params: pill.id === 'stats' ? { card: 'keep' } : null,
            })}
          </View>
        ))}
      </View>
    );
  },
}));

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import LibraryPages from '../LibraryPages';

beforeEach(() => {
  mockOrder = ['saved', 'checks', 'visited', 'stats'];
  mockSetPageOrder.mockClear();
});

describe('LibraryPages', () => {
  it('passes the pills in the reader order to the Library tab, with the bell', () => {
    mockOrder = ['stats', 'saved', 'visited', 'checks'];
    render(<LibraryPages />);
    expect(mockTabProps.tab).toBe('library');
    expect(mockTabProps.trailing).toBe('bell');
    expect(mockTabProps.pages).toEqual([
      { id: 'stats', label: 'nav.page.stats' },
      { id: 'saved', label: 'nav.page.saved' },
      { id: 'visited', label: 'nav.page.visited' },
      { id: 'checks', label: 'nav.page.checks' },
    ]);
  });

  it('gives every page the shared header, the list-end clearance and its own explainer footer', () => {
    render(<LibraryPages />);
    for (const id of ['saved', 'checks', 'visited', 'stats']) {
      expect(mockProps[id].headerHeight).toBe(106);
      expect(mockProps[id].scrollHandler).toBe(mockHeader.scrollHandler);
      expect(mockProps[id].listEndPadding).toBe(172);
      expect(screen.getByTestId(`how-${id}`)).toBeTruthy();
    }
    expect(mockProps.saved.hidden).toBe(mockHeader.hidden);
    expect(mockProps.saved.active).toBe(true);
    expect(mockProps.checks.active).toBe(false);
  });

  it('hands Stats its arrival card', () => {
    render(<LibraryPages />);
    expect(mockProps.stats.requestedCard).toBe('keep');
  });

  it('Checks gets no link to a fact-check setting', () => {
    render(<LibraryPages />);
    expect(mockProps.checks.onTurnOnAutoChecks).toBeUndefined();
  });

  it('saving the arrangement stores the Library order', () => {
    render(<LibraryPages />);
    mockTabProps.arrange.onSave({ order: ['visited', 'saved', 'checks', 'stats'], removed: [], added: [] });
    expect(mockSetPageOrder).toHaveBeenCalledWith('library', ['visited', 'saved', 'checks', 'stats']);
  });
});
