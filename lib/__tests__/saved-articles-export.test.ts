// Unit tests for the pure saved-articles export shaping.
//
// The fixture is built so it cannot pass vacuously. Deliberately present in it:
// a row with no URL, a row with no publication, a standalone save whose reason
// is the empty string, a headline carrying Markdown-significant characters, a
// row with an unparseable publish date, and a reason with an embedded newline.
// A fixture where every field is populated and every row is the same shape
// would pass against several wrong implementations.

import type { SavedItem } from '../database/services/saved-article-suggestion-service';
import {
  buildSavedJson,
  buildSavedMarkdown,
  exportDay,
  toExportRows,
  type SavedExportLabels,
} from '../saved-articles-export';

const LABELS: SavedExportLabels = {
  docTitle: 'Saved articles',
  docExported: 'Exported 2026-09-22',
  reasonLabel: 'Why Mera picked it',
};

/** A 'suggestion' row. Only the fields the export reads are meaningful; the
 *  rest satisfy the store's type. */
function suggestionItem(
  over: Partial<{
    title_en: string | null;
    title_original: string | null;
    publication_name: string | null;
    article_url: string | null;
    firstPubDate: string;
    reason: string;
    savedAt: number;
  }> = {},
): SavedItem {
  return {
    origin: 'suggestion',
    savedAt: over.savedAt ?? Date.UTC(2026, 8, 21, 18, 22, 11),
    suggestion: {
      _id: 'sug-1',
      articleId: 'art-1',
      clusters: [],
      relevance: 0.62,
      reason: over.reason ?? 'Flooding in North Holland reaches the area you live in.',
      status: 'complete' as never,
      country_code: 'NLD',
      language_code: 'nl',
      publication_name:
        'publication_name' in over ? over.publication_name! : 'The Guardian',
      title_en: 'title_en' in over ? over.title_en! : 'Storm warnings extended',
      title_original:
        'title_original' in over ? over.title_original! : 'Stormwaarschuwingen verlengd',
      description_en: null,
      article_url:
        'article_url' in over ? over.article_url! : 'https://example.com/story',
      image_url: null,
      userTopicIds: [],
      createdAt: '2026-09-19T06:00:00.000Z',
      firstPubDate: over.firstPubDate ?? '2026-09-20T06:00:00.000Z',
      rawScore: null,
      eventType: null,
      headlineScope: null,
      matchedTopics: [],
    } as never,
  };
}

/** An 'article' row — a standalone save, which never carried a reason. */
function articleItem(over: Partial<{ savedAt: number }> = {}): SavedItem {
  return {
    origin: 'article',
    savedId: 'saved-2',
    savedAt: over.savedAt ?? Date.UTC(2026, 8, 20, 9, 0, 0),
    article: {
      _id: 'art-2',
      article_url: '',
      source_uri: 'https://example.org/other',
      title: 'Titel op zijn origineel',
      title_en: 'A standalone save',
      description: '',
      pubDate: '2026-09-18T12:00:00.000Z',
      publicationSource: { publication_name: 'NOS', country_code: 'NLD' },
    } as never,
  };
}

describe('toExportRows', () => {
  it('flattens both origins and stamps savedAt as ISO', () => {
    const rows = toExportRows([suggestionItem(), articleItem()], {
      includeReason: true,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      title: 'Storm warnings extended',
      publication: 'The Guardian',
      url: 'https://example.com/story',
      publishedAt: '2026-09-20T06:00:00.000Z',
      savedAt: '2026-09-21T18:22:11.000Z',
      reason: 'Flooding in North Holland reaches the area you live in.',
    });
    expect(rows[1].savedAt).toBe('2026-09-20T09:00:00.000Z');
  });

  it('falls back to the original headline when there is no English one', () => {
    const [row] = toExportRows([suggestionItem({ title_en: null })], {
      includeReason: false,
    });
    expect(row.title).toBe('Stormwaarschuwingen verlengd');
  });

  it('never exports a reason for a standalone save, even with reasons on', () => {
    const [row] = toExportRows([articleItem()], { includeReason: true });
    expect(row.reason).toBeNull();
  });

  it('drops every reason when the reader turned them off', () => {
    const rows = toExportRows([suggestionItem(), articleItem()], {
      includeReason: false,
    });
    expect(rows.map((r) => r.reason)).toEqual([null, null]);
  });

  it('treats an empty reason as absent rather than exporting a blank quote', () => {
    const [row] = toExportRows([suggestionItem({ reason: '   ' })], {
      includeReason: true,
    });
    expect(row.reason).toBeNull();
  });

  it('collapses an embedded newline in a reason to one line', () => {
    const [row] = toExportRows(
      [suggestionItem({ reason: 'First half.\n\nSecond half.' })],
      { includeReason: true },
    );
    expect(row.reason).toBe('First half. Second half.');
  });

  it('nulls a missing url and a missing publication rather than emitting ""', () => {
    const [row] = toExportRows(
      [suggestionItem({ article_url: null, publication_name: null })],
      { includeReason: true },
    );
    expect(row.url).toBeNull();
    expect(row.publication).toBeNull();
  });

  it('falls back to source_uri when the article url is empty', () => {
    const [row] = toExportRows([articleItem()], { includeReason: false });
    expect(row.url).toBe('https://example.org/other');
  });

  it('nulls an unparseable publish date instead of emitting "Invalid Date"', () => {
    const [row] = toExportRows([suggestionItem({ firstPubDate: 'not a date' })], {
      includeReason: false,
    });
    expect(row.publishedAt).toBeNull();
  });

  it('returns an empty array for an empty selection', () => {
    expect(toExportRows([], { includeReason: true })).toEqual([]);
  });
});

describe('buildSavedMarkdown', () => {
  it('writes a title, the export line, and one section per article', () => {
    const rows = toExportRows([suggestionItem(), articleItem()], {
      includeReason: true,
    });
    const md = buildSavedMarkdown(rows, LABELS);

    expect(md).toBe(
      [
        '# Saved articles',
        '',
        'Exported 2026-09-22',
        '',
        '## Storm warnings extended',
        'The Guardian · 2026-09-20 · 2026-09-21',
        'https://example.com/story',
        '',
        '> Why Mera picked it: Flooding in North Holland reaches the area you live in.',
        '',
        '## A standalone save',
        'NOS · 2026-09-18 · 2026-09-20',
        'https://example.org/other',
        '',
      ].join('\n'),
    );
  });

  it('omits the quote block entirely when reasons are off', () => {
    const rows = toExportRows([suggestionItem()], { includeReason: false });
    const md = buildSavedMarkdown(rows, LABELS);
    expect(md).not.toContain('>');
    expect(md).toContain('## Storm warnings extended');
  });

  it('puts a Markdown-significant headline in a heading, not a bullet', () => {
    const rows = toExportRows(
      [suggestionItem({ title_en: '1. *Costs* rise #again _fast_' })],
      { includeReason: false },
    );
    const md = buildSavedMarkdown(rows, LABELS);
    // Verbatim on its own heading line: nothing re-numbers or re-nests around it.
    expect(md).toContain('\n## 1. *Costs* rise #again _fast_\n');
  });

  it('drops the meta separator for a row with no publication', () => {
    const rows = toExportRows([suggestionItem({ publication_name: null })], {
      includeReason: false,
    });
    const md = buildSavedMarkdown(rows, LABELS);
    expect(md).toContain('\n2026-09-20 · 2026-09-21\n');
    expect(md).not.toContain('· 2026-09-20 · 2026-09-21');
  });

  it('omits the link line for a row with no url', () => {
    const rows = toExportRows([suggestionItem({ article_url: null })], {
      includeReason: false,
    });
    expect(buildSavedMarkdown(rows, LABELS)).not.toContain('http');
  });

  it('still produces a usable document for an empty selection', () => {
    expect(buildSavedMarkdown([], LABELS)).toBe(
      '# Saved articles\n\nExported 2026-09-22\n',
    );
  });
});

describe('buildSavedJson', () => {
  const NOW = new Date('2026-09-22T10:14:00.000Z');

  it('carries the export stamp, the count and every row', () => {
    const rows = toExportRows([suggestionItem(), articleItem()], {
      includeReason: true,
    });
    const parsed = JSON.parse(buildSavedJson(rows, { includeReason: true }, NOW));

    expect(parsed.exportedAt).toBe('2026-09-22T10:14:00.000Z');
    expect(parsed.count).toBe(2);
    expect(parsed.includesReason).toBe(true);
    expect(parsed.articles).toHaveLength(2);
    expect(parsed.articles[0].reason).toBe(
      'Flooding in North Holland reaches the area you live in.',
    );
    expect(parsed.articles[1].reason).toBeNull();
  });

  it('reports includesReason from the reader\'s answer, not from the rows', () => {
    // Reasons ON over a selection that is all standalone saves: no row carries
    // a reason, and the export must still say the reader asked for them.
    const rows = toExportRows([articleItem()], { includeReason: true });
    expect(rows.every((r) => r.reason === null)).toBe(true);

    const parsed = JSON.parse(buildSavedJson(rows, { includeReason: true }, NOW));
    expect(parsed.includesReason).toBe(true);
  });

  it('reports includesReason false when the reader declined', () => {
    const rows = toExportRows([suggestionItem()], { includeReason: false });
    const parsed = JSON.parse(buildSavedJson(rows, { includeReason: false }, NOW));
    expect(parsed.includesReason).toBe(false);
  });

  it('emits valid JSON for an empty selection', () => {
    const parsed = JSON.parse(buildSavedJson([], { includeReason: false }, NOW));
    expect(parsed).toEqual({
      exportedAt: '2026-09-22T10:14:00.000Z',
      count: 0,
      includesReason: false,
      articles: [],
    });
  });
});

describe('exportDay', () => {
  it('formats UTC YYYY-MM-DD, the same convention the rows use', () => {
    expect(exportDay(new Date('2026-09-22T23:45:00.000Z'))).toBe('2026-09-22');
  });
});
