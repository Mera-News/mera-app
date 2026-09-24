// story-export — pure shaping for the "export this story" wizard on a followed
// story's timeline.
//
// Same shape as `saved-articles-export.ts` beside it, and reuses its date and
// one-line helpers so the two exports cannot drift into two conventions. No
// database, i18n or React Native imports; the only import from the database
// layer is a TYPE, which TypeScript erases.
//
// Two decisions this module exists to encode:
//
// 1. THE LINK AND THE NOTE COME FROM THE RETENTION ROW, NOT THE SNAPSHOT. A
//    story's member snapshots (what the timeline renders) carry a title, date,
//    publication, language and country, and NO article URL and NO reason. The
//    story's `tracked_story` retention rows in `saved_article_suggestions` carry
//    both, so the caller passes them in keyed by article id. Retention is
//    forward-only and a keep can land before a reason exists, so a member with
//    no retained row, or a retained row with no reason, exports without them
//    rather than being dropped.
//
// 2. A ZERO pubDateMs IS "UNKNOWN", NOT 1970. `sanitizeSnapshots` coerces a
//    missing date to 0, and `new Date(0)` is a valid date that would print as
//    1970-01-01.
//
// No counter, tally or record of what was exported is kept anywhere.

import type { ForYouSuggestion } from './stores/for-you-store';
import { isoDay, oneLine, toIso } from './saved-articles-export';

/** A timeline card, as the story screen holds it. `TimelineCard` satisfies
 *  this structurally; declared here so `lib/` does not import `components/`. */
export interface StoryExportMember {
  articleId: string;
  title: string;
  pubDateMs: number;
  publicationName?: string;
  languageCode?: string;
  countryCode?: string;
}

/** The fields read off a member's retention row. */
export type StoryRetainedRow = Pick<ForYouSuggestion, 'article_url' | 'reason' | 'title_en'>;

/** One article as it appears in a story export, in either format. */
export interface StoryExportRow {
  title: string;
  publication: string | null;
  /** ISO 3166 code as stored on the snapshot, or null. */
  country: string | null;
  /** Original language code, or null. */
  language: string | null;
  url: string | null;
  /** ISO 8601, or null when the member carries no usable publish date. */
  publishedAt: string | null;
  /** Null when there is none, or when the reader turned reasons off. */
  reason: string | null;
}

export interface StoryExportOptions {
  includeReason: boolean;
}

/** Labels resolved by the caller's `t()`, injected to keep this module pure. */
export interface StoryExportLabels {
  /** The story's headline, as the screen shows it. */
  headline: string;
  /** `aiDisclosure.short` when the headline is Mera-written, else omitted. */
  headlineAiLabel?: string;
  /** `savedExport.docExported`, with {{date}} already interpolated. */
  docExported: string;
  /** `savedExport.docReasonLabel` */
  reasonLabel: string;
}

/** Members in the order given (the timeline's newest-first), joined with
 *  their retention rows. */
export function toStoryExportRows(
  members: StoryExportMember[],
  retainedById: ReadonlyMap<string, StoryRetainedRow>,
  opts: StoryExportOptions,
): StoryExportRow[] {
  return members.map((m) => {
    const kept = retainedById.get(m.articleId);
    const reason = oneLine(kept?.reason);
    return {
      title: oneLine(m.title) || oneLine(kept?.title_en),
      publication: oneLine(m.publicationName) || null,
      country: m.countryCode || null,
      language: m.languageCode || null,
      url: kept?.article_url || null,
      publishedAt: m.pubDateMs > 0 ? toIso(m.pubDateMs) : null,
      reason: opts.includeReason && reason ? reason : null,
    };
  });
}

/**
 * The Markdown document: the story headline as a level-1 title, the AI label
 * when the headline is Mera-written, the export date, then one level-2 section
 * per article with its meta line, its link and, when included, its reason.
 */
export function buildStoryMarkdown(
  rows: StoryExportRow[],
  labels: StoryExportLabels,
): string {
  const out: string[] = [`# ${oneLine(labels.headline)}`, ''];
  if (labels.headlineAiLabel) out.push(`_${labels.headlineAiLabel}_`, '');
  out.push(labels.docExported);

  for (const row of rows) {
    out.push('');
    // A heading, not a bullet: see buildSavedMarkdown.
    out.push(`## ${row.title}`);

    const meta = [
      row.publication,
      row.publishedAt ? isoDay(row.publishedAt) : null,
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
 * The JSON document. Keys are English in every locale. `includesReason` is the
 * reader's answer in step 2, passed in rather than derived from the rows, for
 * the reason `buildSavedJson` gives.
 */
export function buildStoryJson(
  rows: StoryExportRow[],
  story: { headline: string; headlineAiGenerated: boolean },
  opts: StoryExportOptions,
  now: Date = new Date(),
): string {
  return JSON.stringify(
    {
      exportedAt: now.toISOString(),
      story: {
        headline: oneLine(story.headline),
        headlineAiGenerated: story.headlineAiGenerated,
      },
      count: rows.length,
      includesReason: opts.includeReason,
      articles: rows,
    },
    null,
    2,
  );
}
