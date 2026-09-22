// saved-articles-export — pure shaping for the "export my saved articles"
// wizard on the Saved tab.
//
// Deliberately has NO database, i18n or React Native imports, the same shape
// as `reading-history-export.ts` beside it: it takes the `SavedItem[]` the
// Saved tab already fetched through `loadSavedItems()` and turns it into the
// exact Markdown or JSON string handed to the share sheet. The only import is
// a TYPE, which TypeScript erases, so this module never reaches
// `lib/database/index.ts` — that file constructs its SQLiteAdapter at import
// time and takes down the suite of anything that touches it.
//
// Three decisions this module exists to encode, so a caller cannot forget one:
//
// 1. THE EXPORTED HEADLINE IS THE STORED ONE, NOT THE PAINTED ONE. A card does
//    not simply print `title_en`: `ArticleCardBase` hands it to
//    `TranslatableDynamic`, which for a non-English reader translates it ON
//    DEVICE into the app language. That translation lives in an in-memory
//    cache filled only for rows that have actually been on screen. Exporting
//    it would produce a file translated for the rows the reader happened to
//    scroll past and English for the rest, so the export writes
//    `title_en ?? title_original` uniformly instead. The wizard's own list
//    renders through `TranslatableDynamic` so its rows stay recognisable; the
//    difference between that list and the file is accepted and stated here.
//
// 2. THE DOCUMENT'S LABELS ARE INJECTED, THE JSON'S KEYS ARE NOT. Markdown is
//    something a person reads, so its three labels arrive from the caller's
//    `t()` already resolved — passing them in rather than importing i18n is
//    what keeps this module pure. JSON is a machine format and its keys stay
//    English in every locale.
//
// 3. ONLY 'suggestion' ROWS HAVE A REASON. A standalone article save stores
//    `reason` as the empty string (there was never a scoring pass to explain),
//    so `includeReason` yields null for those rows rather than an empty quote
//    block. The toggle governs Markdown and JSON identically.
//
// No counter, tally or record of what was exported is kept anywhere. Exporting
// is not an event this app measures.

import type { SavedItem } from './database/services/saved-article-suggestion-service';

/** One article as it appears in an export, in either format. */
export interface SavedExportRow {
  /** `title_en ?? title_original ?? ''` — see decision 1 in the file header. */
  title: string;
  publication: string | null;
  url: string | null;
  /** ISO 8601, or null when the row carries no usable publish date. */
  publishedAt: string | null;
  /** ISO 8601. Always present: it is the column the Saved list sorts on. */
  savedAt: string;
  /** Null on a standalone article save, and null whenever the reader turned
   *  the reason off in step 2. */
  reason: string | null;
}

/** The three Markdown labels, resolved by the caller's `t()`. Injected rather
 *  than imported so this module stays i18n-free and testable. */
export interface SavedExportLabels {
  /** `savedExport.docTitle` */
  docTitle: string;
  /** `savedExport.docExported`, with {{date}} already interpolated. */
  docExported: string;
  /** `savedExport.docReasonLabel` */
  reasonLabel: string;
}

export interface ToExportRowsOptions {
  includeReason: boolean;
}

/** `Date` -> `YYYY-MM-DD`, in UTC.
 *
 *  Locale-free on purpose. This string lands in a file that leaves the device
 *  and may be opened anywhere, where `03/04` is genuinely ambiguous and a
 *  locale-formatted date would be formatted for whoever exported it rather
 *  than whoever reads it. UTC rather than local for the same reason: two
 *  exports of the same library should not disagree because of where they were
 *  taken. */
function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

/** The `YYYY-MM-DD` the caller interpolates into `savedExport.docExported`.
 *  Exported so the document's own date and its rows' dates come from one
 *  formatter and cannot drift into two conventions inside one file. */
export function exportDay(now: Date = new Date()): string {
  return isoDay(now.toISOString());
}

/** An ISO string, or null when the value is missing or unparseable. A saved
 *  row's `firstPubDate` is non-null in the schema but reaches here through the
 *  server's article shape, where it is a string that has been wrong before. */
function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Trim to a single line. A reason is one sentence and a headline is one line,
 *  but both arrive from a server and an embedded newline would break a
 *  Markdown list item into a paragraph mid-entry. */
function oneLine(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Flattens the Saved tab's own rows into export rows, newest save first.
 *
 * The input must be what `loadSavedItems()` returned: it already drops the
 * `fact_check` and `tracked_story` retention origins, so the export set is
 * exactly the list the reader can open and count. Never hand-roll that query.
 */
export function toExportRows(
  items: SavedItem[],
  opts: ToExportRowsOptions,
): SavedExportRow[] {
  return items.map((item) => {
    if (item.origin === 'article') {
      const a = item.article;
      return {
        title: oneLine(a.title_en ?? a.title),
        publication: oneLine(a.publicationSource?.publication_name) || null,
        url: a.article_url || a.source_uri || null,
        publishedAt: toIso(a.pubDate),
        savedAt: new Date(item.savedAt).toISOString(),
        // A standalone save was never scored, so there is no reason to include
        // even when the reader asked for reasons.
        reason: null,
      };
    }
    const s = item.suggestion;
    const reason = oneLine(s.reason);
    return {
      title: oneLine(s.title_en ?? s.title_original),
      publication: oneLine(s.publication_name) || null,
      url: s.article_url || null,
      publishedAt: toIso(s.firstPubDate ?? s.createdAt),
      savedAt: new Date(item.savedAt).toISOString(),
      reason: opts.includeReason && reason ? reason : null,
    };
  });
}

/**
 * The Markdown document: a level-1 title, the export date, then one level-2
 * section per article carrying its meta line, its link and, when included, its
 * reason as a block quote.
 */
export function buildSavedMarkdown(
  rows: SavedExportRow[],
  labels: SavedExportLabels,
): string {
  const out: string[] = [
    `# ${labels.docTitle}`,
    '',
    labels.docExported,
  ];

  for (const row of rows) {
    out.push('');
    // The title goes in a heading rather than a bullet so a headline
    // containing "*", "_", "#" or a leading digit cannot be read as markup
    // that reshapes the list around it. A heading ends at its newline.
    out.push(`## ${row.title}`);

    const meta = [
      row.publication,
      row.publishedAt ? isoDay(row.publishedAt) : null,
      isoDay(row.savedAt),
    ].filter((part): part is string => !!part);
    if (meta.length > 0) out.push(meta.join(' · '));

    if (row.url) out.push(row.url);

    if (row.reason) {
      out.push('');
      out.push(`> ${labels.reasonLabel}: ${row.reason}`);
    }
  }

  out.push('');
  return out.join('\n');
}

/**
 * The JSON document. Keys are English in every locale: this is a machine
 * format, and a reader who picked JSON picked it to feed something else.
 *
 * `includesReason` is the reader's ANSWER in step 2, passed in, not something
 * derived from the rows. Deriving it (`rows.some(r => r.reason !== null)`)
 * looks equivalent and is not: an export taken with reasons ON, of a selection
 * that happens to be all standalone saves, would report `false` and claim the
 * reader declined something they asked for.
 */
export function buildSavedJson(
  rows: SavedExportRow[],
  opts: ToExportRowsOptions,
  now: Date = new Date(),
): string {
  return JSON.stringify(
    {
      exportedAt: now.toISOString(),
      count: rows.length,
      includesReason: opts.includeReason,
      articles: rows,
    },
    null,
    2,
  );
}
