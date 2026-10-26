// The plain-text forms of a fact check: the Share message (one check) and the Library export
// (several, Markdown or JSON). The fixture mixes the shapes a real table holds so nothing passes
// vacuously: a published rating in capitals with a summary and link, one with neither, an insecure
// link, a check nobody has published on, a payload with nothing at all, and a still-pending row
// that carries a STALE verdict from before a recheck.

import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import {
  buildFactCheckShareMessage,
  buildFactChecksJson,
  buildFactChecksMarkdown,
  factCheckContent,
  toFactCheckExportRows,
  type FactCheckTextLabels,
} from '@/lib/fact-check/fact-check-text';
import type { FactCheckRow } from '@/lib/fact-check/fact-check-types';

const LABELS: FactCheckTextLabels = {
  factChecks: 'Fact checks',
  claims: 'Claims checked',
  aiSummary: "Mera's AI summary (written by AI, can be wrong)",
  sources: 'Sources',
  noneFound: 'No published fact checks found',
  rating: (raw) => (raw ? raw.charAt(0) + raw.slice(1).toLowerCase() : 'Unclear'),
  assessment: (raw) => (raw === 'supported' ? 'Backed by sources' : 'Unclear'),
  rated: (organisation, rating, summary) =>
    summary ? `${organisation} rated it ${rating}: “${summary}”` : `${organisation} rated it ${rating}`,
};

function payload(over: Partial<FactCheckRow> = {}): FactCheckRow {
  return {
    _id: 'fc1',
    status: 'complete',
    verdict: 'supported',
    summary: 'The claims  are supported\nby independent reporting.',
    checkedBy: [
      { organisation: 'FACTLY', verdict: 'MISLEADING', summary: 'An unrelated video.', url: 'https://factly.in/a' },
      { organisation: 'BOOM', verdict: null, summary: null, url: 'http://boomlive.in/b' },
      { organisation: '  ', verdict: 'False', url: 'https://nameless.example/c' },
    ],
    checkedByStatus: 'searched',
    citations: [
      { uri: 'https://openthemagazine.com/x', title: 'Open', snippet: 'SUMMARY: long text' },
      { uri: 'http://insecure.example/y' },
      { uri: 'https://thefederal.com/z' },
    ],
    claims: [
      { claim: 'The CJP was founded in May 2026.', assessment: 'supported' },
      { claim: 'Leaders were detained.', assessment: 'weird-token' },
    ],
    articleTitle: 'Server title',
    articleUrl: 'https://organiser.org/story',
    publicationName: 'Organiser',
    ...over,
  };
}

function stored(id: string, over: Partial<StoredFactCheck<FactCheckRow>> = {}): StoredFactCheck<FactCheckRow> {
  return {
    id,
    articleId: `a-${id}`,
    factCheckId: `fc-${id}`,
    articleTitle: `Title ${id}`,
    status: 'complete',
    verdict: null,
    payload: payload(),
    requestedAt: Date.UTC(2026, 9, 24, 8),
    resolvedAt: Date.UTC(2026, 9, 25, 9),
    claim: null,
    claimKey: null,
    ...over,
  };
}

describe('factCheckContent', () => {
  it('keeps named organisations, secure links only, and one-line text', () => {
    const content = factCheckContent(payload());
    expect(content.factChecks).toEqual([
      { organisation: 'FACTLY', rating: 'MISLEADING', summary: 'An unrelated video.', url: 'https://factly.in/a' },
      { organisation: 'BOOM', rating: null, summary: null, url: null },
    ]);
    expect(content.sources).toEqual(['https://openthemagazine.com/x', 'https://thefederal.com/z']);
    expect(content.summary).toBe('The claims are supported by independent reporting.');
    expect(content.claims).toHaveLength(2);
  });

  it('is empty, never throws, for a null payload', () => {
    expect(factCheckContent(null)).toEqual({ factChecks: [], claims: [], summary: null, sources: [] });
  });
});

describe('buildFactCheckShareMessage', () => {
  const article = { title: 'Unmasking CJP', publication: 'Organiser', date: '24 Oct 2026', url: 'https://organiser.org/story?utm=share' };
  const footer = 'Checked 25 Oct 2026. Shared via https://mera.news';

  it('puts every section in reading order, blank-line separated, as plain text', () => {
    const message = buildFactCheckShareMessage({ article, content: factCheckContent(payload()), labels: LABELS, footer });
    expect(message).toBe([
      'Unmasking CJP\nOrganiser, 24 Oct 2026\nhttps://organiser.org/story?utm=share',
      'Fact checks\nFACTLY rated it Misleading: “An unrelated video.”\nhttps://factly.in/a\nBOOM rated it Unclear',
      'Claims checked\n1. The CJP was founded in May 2026. Backed by sources\n2. Leaders were detained. Unclear',
      "Mera's AI summary (written by AI, can be wrong)\nThe claims are supported by independent reporting.",
      'Sources\nhttps://openthemagazine.com/x\nhttps://thefederal.com/z',
      footer,
    ].join('\n\n'));
    // Plain text: no markdown markers anywhere.
    expect(message).not.toMatch(/\*\*|^#|^- /m);
  });

  it('leaves out every empty section, so a check nobody published on still shares the rest', () => {
    const content = factCheckContent(payload({ checkedBy: [], claims: [], citations: [] }));
    const message = buildFactCheckShareMessage({
      article: { title: 'Unmasking CJP', publication: null, date: null, url: null },
      content,
      labels: LABELS,
      footer,
    });
    expect(message).toBe([
      'Unmasking CJP',
      "Mera's AI summary (written by AI, can be wrong)\nThe claims are supported by independent reporting.",
      footer,
    ].join('\n\n'));
  });
});

describe('the Library export', () => {
  const all = { includeClaims: true, includeSummary: true, includeSources: true };
  const none = { includeClaims: false, includeSummary: false, includeSources: false };

  it('always carries headline, publication, link and every rating; the rest only when asked', () => {
    const [row] = toFactCheckExportRows([stored('1')], none);
    expect(row).toEqual({
      title: 'Title 1',
      publication: 'Organiser',
      url: 'https://organiser.org/story',
      checkedAt: '2026-10-25T09:00:00.000Z',
      factChecks: [
        { organisation: 'FACTLY', rating: 'MISLEADING', summary: 'An unrelated video.', url: 'https://factly.in/a' },
        { organisation: 'BOOM', rating: null, summary: null, url: null },
      ],
      claims: null,
      meraAiSummary: null,
      sources: null,
    });
    const [full] = toFactCheckExportRows([stored('1')], all);
    expect(full.claims).toEqual([
      { claim: 'The CJP was founded in May 2026.', assessment: 'supported' },
      { claim: 'Leaders were detained.', assessment: 'weird-token' },
    ]);
    expect(full.meraAiSummary).toBe('The claims are supported by independent reporting.');
    expect(full.sources).toEqual(['https://openthemagazine.com/x', 'https://thefederal.com/z']);
  });

  it('never exports a pending row, even one still holding a stale verdict from before a recheck', () => {
    const rows = toFactCheckExportRows([stored('1'), stored('2', { status: 'pending', resolvedAt: null })], all);
    expect(rows.map((r) => r.title)).toEqual(['Title 1']);
  });

  it('writes Markdown with the AI summary labelled and the no-checks line when nobody published', () => {
    const rows = toFactCheckExportRows(
      [stored('1'), stored('2', { payload: payload({ checkedBy: [], claims: [], citations: [], summary: null }) })],
      all,
    );
    const md = buildFactChecksMarkdown(rows, { ...LABELS, docTitle: 'Fact checks', docExported: 'Exported 2026-10-26' });
    expect(md).toBe([
      '# Fact checks',
      '',
      'Exported 2026-10-26',
      '',
      '## Title 1',
      'Organiser · 2026-10-25',
      'https://organiser.org/story',
      '',
      '- FACTLY rated it Misleading: “An unrelated video.” https://factly.in/a',
      '- BOOM rated it Unclear',
      '',
      '**Claims checked**',
      '1. The CJP was founded in May 2026. Backed by sources',
      '2. Leaders were detained. Unclear',
      '',
      "**Mera's AI summary (written by AI, can be wrong)**",
      'The claims are supported by independent reporting.',
      '',
      '**Sources**',
      '- https://openthemagazine.com/x',
      '- https://thefederal.com/z',
      '',
      '## Title 2',
      'Organiser · 2026-10-25',
      'https://organiser.org/story',
      '',
      'No published fact checks found',
      '',
    ].join('\n'));
  });

  it('writes JSON with what was included and the AI summary under a key that says so', () => {
    const rows = toFactCheckExportRows([stored('1')], { ...none, includeSummary: true });
    const json = JSON.parse(buildFactChecksJson(rows, { ...none, includeSummary: true }, new Date(Date.UTC(2026, 9, 26))));
    expect(json).toMatchObject({
      exportedAt: '2026-10-26T00:00:00.000Z',
      count: 1,
      includesClaims: false,
      includesMeraAiSummary: true,
      includesSources: false,
    });
    expect(json.factChecks[0].meraAiSummary).toBe('The claims are supported by independent reporting.');
    expect(json.factChecks[0].factChecks[0].rating).toBe('MISLEADING');
  });
});
