// The article page's fact-check card, rendered for real over a row stored through the app's own
// service: its sections, Share (the plain-text message to the native sheet) and Fact check again
// (the recheck mutation, its once-a-day state, and the stale verdict a pending recheck still holds).
// Fakes: the native share sheet, and the network through MSW.
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { Share } from 'react-native';
import FactCheckPanel from '@/components/custom/news-detail/FactCheckPanel';
import { upsertFactCheck } from '@/lib/database/services/fact-check-record-service';
import type { FactCheckRow } from '@/lib/fact-check/fact-check-types';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn, mockGql, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import { askedIds, checkRow, serveChecks } from './kit';

const DAY = 86_400_000;

const published = (over: Partial<FactCheckRow> = {}): FactCheckRow =>
  checkRow({
    summary: 'The factual claims are supported by independent reporting.',
    checkedBy: [{ organisation: 'FACTLY', verdict: 'MISLEADING', summary: 'An unrelated video from Bhopal.', url: 'https://factly.in/a' }],
    claims: [
      { claim: 'The CJP was founded in May 2026.', assessment: 'unverifiable' },
      { claim: 'Leaders were detained.', assessment: 'supported' },
    ],
    citations: ['openthemagazine.com', 'www.thefederal.com', 'wikipedia.org', 'aspiroliving.com', 'youtube.com'].map((d) => ({
      uri: `https://${d}/x`,
      title: d,
      snippet: 'SUMMARY: a long snippet the card no longer repeats',
    })),
    recheckAvailableAt: new Date(Date.now() - 1000).toISOString(),
    ...over,
  });

const seed = (row: FactCheckRow, status = row.status) =>
  upsertFactCheck({ articleId: 'a1', factCheckId: String(row._id), articleTitle: 'Server title', status, payload: row });

const ARTICLE = { title: 'Unmasking CJP', language: 'en', publication: 'Organiser', pubDate: '2026-10-24T08:00:00.000Z', url: 'https://organiser.org/story' };
const renderPanel = () => render(<FactCheckPanel articleId="a1" article={ARTICLE} />);

beforeAll(initI18nEn);
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});
afterEach(() => {
  resetChatModules();
  jest.restoreAllMocks();
});

describe('the article fact-check card', () => {
  it('shows published checks first, then Mera labelled AI, the claims, and three sources', async () => {
    await seed(published());
    const panel = renderPanel();
    await waitFor(() => expect(panel.getByTestId('fact-check-0-result')).toBeTruthy());

    expect(panel.getByText('Published fact checks')).toBeTruthy();
    const org = within(panel.getByTestId('fact-check-0-org-0'));
    expect(org.getByText('FACTLY')).toBeTruthy();
    expect(org.getByText('Misleading')).toBeTruthy();
    expect(panel.getByText('What Mera found')).toBeTruthy();
    expect(panel.getByText('AI-generated')).toBeTruthy();
    expect(panel.getByText('Claims checked')).toBeTruthy();
    expect(within(panel.getByTestId('fact-check-0-claim-1')).getByText('Backed by sources')).toBeTruthy();

    expect(panel.getByText('5 sources')).toBeTruthy();
    expect(panel.getByText('thefederal.com')).toBeTruthy();
    expect(panel.queryByText('youtube.com')).toBeNull();
    expect(panel.queryByText(/SUMMARY:/)).toBeNull();
    fireEvent.press(panel.getByText('Show 2 more'));
    expect(panel.getByText('youtube.com')).toBeTruthy();
  });

  it('shares the whole check as plain text, headline first and the footer last', async () => {
    await seed(published());
    const shared = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const panel = renderPanel();
    await waitFor(() => expect(panel.getByTestId('fact-check-0-share')).toBeTruthy());

    fireEvent.press(panel.getByTestId('fact-check-0-share'));
    await waitFor(() => expect(shared).toHaveBeenCalledTimes(1));

    const message = (shared.mock.calls[0][0] as { message: string }).message;
    const sections = message.split('\n\n');
    expect(sections[0]).toMatch(/^Unmasking CJP\nOrganiser, Oct 24, 2026\nhttps:\/\/organiser\.org\/story\?/);
    expect(sections[1]).toBe('Fact checks\nFACTLY rated it Misleading: “An unrelated video from Bhopal.”\nhttps://factly.in/a');
    expect(sections[2]).toBe("Claims checked\n1. The CJP was founded in May 2026. Couldn't confirm\n2. Leaders were detained. Backed by sources");
    expect(sections[3]).toMatch(/^Mera's AI summary \(written by AI, can be wrong\)\n/);
    expect(sections[4].split('\n')).toHaveLength(6);
    expect(sections[5]).toMatch(/^Checked .+\. Shared via https?:\/\//);
  });

  it('asks the server to check again, then shows the checking state, never the stale verdict', async () => {
    await seed(published());
    // The recheck answers PENDING with the old verdict fields still on the row.
    const stale = { ...published(), status: 'pending', recheckAvailableAt: null } as FactCheckRow;
    const asked: unknown[] = [];
    server.use(
      mockGql('RequestFactCheckAgain', (v) => {
        asked.push(v);
        return { requestFactCheck: stale };
      }),
    );
    serveChecks({ ask: () => stale });
    const panel = renderPanel();
    await waitFor(() => expect(panel.getByTestId('fact-check-0-again')).toBeTruthy());
    expect(within(panel.getByTestId('fact-check-0-again')).getByText('Fact check again')).toBeTruthy();

    fireEvent.press(panel.getByTestId('fact-check-0-again'));

    await waitFor(() => expect(panel.getByTestId('fact-check-working')).toBeTruthy());
    expect(asked).toEqual([{ articleId: 'a1' }]);
    expect(panel.queryByTestId('fact-check-0-result')).toBeNull();
    expect(panel.queryByText('Misleading')).toBeNull();
    expect(await askedIds()).toContain('a1');
    panel.unmount();
  });

  it('reads "Checked recently" and asks nothing while recheckAvailableAt is in the future', async () => {
    await seed(published({ recheckAvailableAt: new Date(Date.now() + DAY).toISOString() }));
    const asked = jest.fn(() => ({ requestFactCheck: published() }));
    server.use(mockGql('RequestFactCheckAgain', asked));
    const panel = renderPanel();
    await waitFor(() => expect(panel.getByTestId('fact-check-0-again')).toBeTruthy());

    const again = panel.getByTestId('fact-check-0-again');
    expect(within(again).getByText('Checked recently')).toBeTruthy();
    expect(again.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(again);
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).not.toHaveBeenCalled();
  });

  it('turns to "Checked recently" when the server answers a too-early recheck unchanged', async () => {
    await seed(published());
    server.use(
      mockGql('RequestFactCheckAgain', () => ({
        requestFactCheck: published({ recheckAvailableAt: new Date(Date.now() + DAY).toISOString() }),
      })),
    );
    const panel = renderPanel();
    await waitFor(() => expect(panel.getByTestId('fact-check-0-again')).toBeTruthy());

    fireEvent.press(panel.getByTestId('fact-check-0-again'));

    await waitFor(() => expect(within(panel.getByTestId('fact-check-0-again')).getByText('Checked recently')).toBeTruthy());
    expect(panel.getByText('Misleading')).toBeTruthy();
    expect(await askedIds()).toEqual([]);
  });

  it('says the article is no longer available when the server no longer holds it (MERA-APP-92)', async () => {
    await seed(published());
    server.use(mockGqlError('RequestFactCheckAgain', 'NOT_FOUND', { message: 'Article not found: a1', statusCode: 404 }));
    const info = jest.spyOn(toastManager, 'showInfo');
    const panel = renderPanel();
    await waitFor(() => expect(panel.getByTestId('fact-check-0-again')).toBeTruthy());

    fireEvent.press(panel.getByTestId('fact-check-0-again'));

    await waitFor(() => expect(info).toHaveBeenCalledWith('This article is no longer available'));
    expect(panel.getByText('Misleading')).toBeTruthy();
    expect(await askedIds()).toEqual([]);
    info.mockRestore();
  });

  it('offers no recheck on a blocked check', async () => {
    await seed(published({ status: 'blocked' }));
    const panel = renderPanel();
    await waitFor(() => expect(panel.getByTestId('fact-check-0-blocked')).toBeTruthy());
    expect(panel.queryByTestId('fact-check-0-again')).toBeNull();
  });
});
