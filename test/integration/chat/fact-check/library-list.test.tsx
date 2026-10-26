// The Library's Fact checks list: each card is a one-line summary (the first organisation and its
// own rating, "+N more", nobody published, or still checking), and the Export wizard writes the
// chosen finished checks as Markdown or JSON. The shared wizard still drives the Saved export.
// Fakes: the RN Modal native spec and the share sheets: `expo-sharing` reports no file sharing, so
// the export takes the text fallback, which carries the same document to `Share.share`.
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { OverlayProvider } from '@gluestack-ui/core/overlay/creator';
import * as Sharing from 'expo-sharing';
import React from 'react';
import { Share } from 'react-native';
import FactCheckCard from '@/components/custom/fact-checks/FactCheckCard';
import FactCheckExportModal from '@/components/custom/fact-checks/FactCheckExportModal';
import SavedExportModal from '@/components/custom/saved-suggestions/SavedExportModal';
import type { SavedItem } from '@/lib/database/services/saved-article-suggestion-service';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import type { FactCheckRow } from '@/lib/fact-check/fact-check-types';
import { initI18nEn } from '@/test/helpers';
import { checkRow } from './kit';

jest.mock('react-native/Libraries/Modal/Modal', () => {
  const { View } = jest.requireActual('react-native');
  return { __esModule: true, default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null) };
});

beforeAll(initI18nEn);
afterEach(() => jest.restoreAllMocks());

const HOUR = 3_600_000;
const org = (organisation: string, verdict: string) => ({ organisation, verdict, url: `https://${organisation.toLowerCase()}.example/x`, summary: 'Their words.' });

function stored(id: string, payload: Partial<FactCheckRow>, over: Partial<StoredFactCheck> = {}): StoredFactCheck<FactCheckRow> {
  return {
    id,
    articleId: `a-${id}`,
    factCheckId: `fc-${id}`,
    articleTitle: `Headline ${id}`,
    status: 'complete',
    verdict: null,
    payload: checkRow({ publicationName: 'Organiser', ...payload }),
    requestedAt: Date.now() - 30 * HOUR,
    resolvedAt: Date.now() - 26 * HOUR,
    claim: null,
    claimKey: null,
    ...over,
  };
}

const card = (item: StoredFactCheck) => render(<FactCheckCard item={item} onPress={() => {}} onDelete={() => {}} testIDPrefix="c" />);

describe('the list card is a summary', () => {
  it('leads with the first organisation and its rating, sentence-cased, and nothing else', () => {
    const view = card(stored('1', { checkedBy: [org('FACTLY', 'MISLEADING')] }));
    const summary = within(view.getByTestId('c-summary-1'));
    expect(summary.getByText('FACTLY')).toBeTruthy();
    expect(summary.getByText('Misleading')).toBeTruthy();
    expect(view.getByText('Organiser')).toBeTruthy();
    expect(view.getByText('Checked 1d ago')).toBeTruthy();
    expect(view.queryByTestId('c-more-1')).toBeNull();
    // No claims, no sources, no Mera summary on the list.
    expect(view.queryByText(/Repairs run through spring/)).toBeNull();
    expect(view.queryByText(/City council minutes/)).toBeNull();
    expect(view.queryByText(/main claims match/)).toBeNull();
  });

  it('counts the other organisations as "+N more"', () => {
    const view = card(stored('1', { checkedBy: [org('FACTLY', 'False'), org('BOOM', 'Fake'), org('AFP', 'Altered')] }));
    expect(view.getByTestId('c-more-1').props.children).toBe('+2 more');
  });

  it('says so when nobody has published', () => {
    const view = card(stored('1', { checkedBy: [], checkedByStatus: 'searched' }));
    expect(within(view.getByTestId('c-summary-1')).getByText('No published fact checks found')).toBeTruthy();
  });

  it('shows checking, never the stale verdict, on a row pending a recheck', () => {
    const item = stored('1', { status: 'pending', checkedBy: [org('FACTLY', 'MISLEADING')] }, { status: 'pending', resolvedAt: null, requestedAt: Date.now() - 5 * 60_000 });
    const view = card(item);
    expect(view.getByTestId('c-checking-1')).toBeTruthy();
    expect(view.getByText('Checking this with fact checkers…')).toBeTruthy();
    expect(view.getByText('Asked 5m ago')).toBeTruthy();
    expect(view.queryByText('FACTLY')).toBeNull();
    expect(view.queryByText('Misleading')).toBeNull();
  });
});

/** The document an export handed to the share sheet. */
function shareSheet() {
  jest.spyOn(Sharing, 'isAvailableAsync').mockResolvedValue(false);
  return jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
}

async function openExport(items: StoredFactCheck[]) {
  const shared = shareSheet();
  const onClose = jest.fn();
  // The kit Modal portals into the app root's OverlayProvider.
  const view = render(<OverlayProvider><FactCheckExportModal isOpen onClose={onClose} items={items} onFailed={() => {}} /></OverlayProvider>);
  await act(async () => {});
  return { view, shared, onClose };
}

describe('the Fact checks export', () => {
  const items = [
    stored('1', { checkedBy: [org('FACTLY', 'MISLEADING')] }),
    stored('2', { checkedBy: [] }),
    stored('3', { status: 'pending', checkedBy: [org('FACTLY', 'OLD')] }, { status: 'pending', resolvedAt: null }),
  ];

  it('preselects the finished checks and leaves a running one unpickable', async () => {
    const { view } = await openExport(items);
    expect(view.getByText('Choose fact checks')).toBeTruthy();
    expect(view.getByTestId('fact-check-export-count').props.children).toBe('2 selected');
    expect(view.getByTestId('fact-check-export-row-3').props.accessibilityState).toMatchObject({ checked: false, disabled: true });
    expect(view.getByText('Organiser · FACTLY: Misleading')).toBeTruthy();
    expect(view.getByText('Organiser · Still checking')).toBeTruthy();

    fireEvent.press(view.getByTestId('fact-check-export-select-all'));
    expect(view.getByTestId('fact-check-export-count').props.children).toBe('0 selected');
    fireEvent.press(view.getByTestId('fact-check-export-select-all'));
    expect(view.getByTestId('fact-check-export-count').props.children).toBe('2 selected');
  });

  it('writes the chosen checks as Markdown, without the parts the reader unticked', async () => {
    const { view, shared, onClose } = await openExport(items);
    fireEvent.press(view.getByTestId('fact-check-export-row-2'));
    fireEvent.press(view.getByTestId('fact-check-export-next'));
    expect(view.getByText(/Each export always has the headline/)).toBeTruthy();
    fireEvent.press(view.getByTestId('fact-check-export-include-sources'));
    fireEvent.press(view.getByTestId('fact-check-export-next'));
    fireEvent.press(view.getByTestId('fact-check-export-format-markdown'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const md = (shared.mock.calls[0][0] as { message: string }).message;
    expect(md).toMatch(/^# Fact checks\n/);
    expect(md).toContain('## Headline 1');
    expect(md).toContain('- FACTLY rated it Misleading: “Their words.” https://factly.example/x');
    expect(md).toContain('**Claims checked**');
    expect(md).toContain("**Mera's AI summary (written by AI, can be wrong)**");
    expect(md).not.toContain('**Sources**');
    expect(md).not.toContain('Headline 2');
    expect(md).not.toContain('Headline 3');
  });

  it('writes JSON with every finished check and what was included', async () => {
    const { view, shared, onClose } = await openExport(items);
    fireEvent.press(view.getByTestId('fact-check-export-next'));
    fireEvent.press(view.getByTestId('fact-check-export-next'));
    fireEvent.press(view.getByTestId('fact-check-export-format-json'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const json = JSON.parse((shared.mock.calls[0][0] as { message: string }).message);
    expect(json).toMatchObject({ count: 2, includesClaims: true, includesMeraAiSummary: true, includesSources: true });
    expect(json.factChecks.map((r: { title: string }) => r.title)).toEqual(['Headline 1', 'Headline 2']);
    expect(json.factChecks[1].factChecks).toEqual([]);
  });
});

describe('the Saved export on the shared wizard', () => {
  const saved: SavedItem = {
    origin: 'suggestion',
    savedAt: Date.UTC(2026, 8, 21),
    suggestion: {
      _id: 'sug-1',
      articleId: 'art-1',
      reason: 'Flooding reaches where you live.',
      language_code: 'nl',
      publication_name: 'The Guardian',
      title_en: 'Storm warnings extended',
      title_original: 'Stormwaarschuwingen verlengd',
      article_url: 'https://example.com/story',
      image_url: 'https://example.com/a.jpg',
      createdAt: '2026-09-19T06:00:00.000Z',
      firstPubDate: '2026-09-20T06:00:00.000Z',
    } as never,
  };

  it('keeps its reason (on) and image (off) choices', async () => {
    const shared = shareSheet();
    const onClose = jest.fn();
    const view = render(<OverlayProvider><SavedExportModal isOpen onClose={onClose} items={[saved]} onFailed={() => {}} /></OverlayProvider>);
    await act(async () => {});
    expect(view.getByTestId('saved-export-count').props.children).toBe('0 selected');
    fireEvent.press(view.getByTestId('saved-export-select-all'));
    fireEvent.press(view.getByTestId('saved-export-next'));
    expect(view.getByTestId('saved-export-include-reason').props.accessibilityState).toMatchObject({ checked: true });
    expect(view.getByTestId('saved-export-include-image').props.accessibilityState).toMatchObject({ checked: false });
    fireEvent.press(view.getByTestId('saved-export-include-image'));
    fireEvent.press(view.getByTestId('saved-export-next'));
    fireEvent.press(view.getByTestId('saved-export-format-json'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const json = JSON.parse((shared.mock.calls[0][0] as { message: string }).message);
    expect(json).toMatchObject({ count: 1, includesReason: true, includesImage: true });
    expect(json.articles[0]).toMatchObject({ reason: 'Flooding reaches where you live.', imageUrl: 'https://example.com/a.jpg' });
  });
});
