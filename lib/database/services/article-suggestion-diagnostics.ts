// Article Suggestion Service: scoring diagnostics.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type ArticleSuggestionModel from '../models/ArticleSuggestion';
import type { RelevanceComponents } from '@/lib/news-harness/scoring-engine/relevance';

const articleSuggestionsCol = database.get<ArticleSuggestionModel>('article_suggestions');

/**
 * How many stored notes are SHARED between articles.
 *
 * WHY THIS IS THE READOUT THAT MATTERS. When a note turns up describing a
 * different article than the one it sits on, there are three candidate causes
 * and they are otherwise indistinguishable after the fact: a batch decode that
 * zipped results to articles by array position, a propagated donor reason, or a
 * model that echoed one of its prompt's worked examples. Only ONE of them
 * duplicates a string — propagation copies the donor's sentence byte for byte,
 * so its fingerprint is the same `reason` on two article ids. A decode shift or
 * a confabulation produces a sentence that exists exactly once. So a non-zero
 * `sharedNoteGroups` says "propagation", and a zero says "look at the decoder
 * or the prompt" — without needing an extra column or a single write.
 *
 * Note that sharing is NORMAL and expected in moderation: propagation exists on
 * purpose, so story siblings legitimately share a note. It is the SIZE and the
 * membership of a group that indict it — a group spanning articles that are not
 * the same story is a grouping false positive.
 */
export interface SharedNoteBreakdown {
  /** Rows carrying a non-empty note at all (the denominator). */
  rowsWithNote: number;
  /** Distinct note strings among them. */
  distinctNotes: number;
  /** Notes appearing on 2+ article ids. Zero ⇒ nothing was propagated. */
  sharedNoteGroups: number;
  /** Rows whose note is shared with at least one other row. */
  rowsSharingANote: number;
  /** Size of the biggest shared group. */
  largestGroupSize: number;
  /** The biggest group, for eyeballing: is this really one story? Truncated —
   *  the note to 120 chars, the titles to 80, and at most 6 members. */
  largestGroup: { note: string; titles: string[] } | null;
}

/**
 * Count how many stored notes are shared across articles. See
 * {@link SharedNoteBreakdown} for why this is the diagnostic that discriminates
 * propagation from a decode shift.
 *
 * ON-DEMAND ONLY (the Observability screen's refresh), like
 * {@link getScoringModeBreakdown} beside it: it fetches every row carrying a
 * note. Read-only, and it never throws — a caller renders '—' on failure.
 */
export async function getSharedNoteBreakdown(): Promise<SharedNoteBreakdown> {
  const empty: SharedNoteBreakdown = {
    rowsWithNote: 0,
    distinctNotes: 0,
    sharedNoteGroups: 0,
    rowsSharingANote: 0,
    largestGroupSize: 0,
    largestGroup: null,
  };
  // `reason` is NOT NULL with '' for absent, so an inequality against '' is the
  // whole predicate — no null branch needed.
  const rows = await articleSuggestionsCol
    .query(Q.where('reason', Q.notEq('')))
    .fetch();
  if (rows.length === 0) return empty;

  const byNote = new Map<string, ArticleSuggestionModel[]>();
  for (const row of rows) {
    const note = (row.reason ?? '').trim();
    if (note.length === 0) continue;
    const bucket = byNote.get(note);
    if (bucket) bucket.push(row);
    else byNote.set(note, [row]);
  }

  let sharedNoteGroups = 0;
  let rowsSharingANote = 0;
  let largest: ArticleSuggestionModel[] = [];
  let largestNote = '';
  for (const [note, members] of byNote) {
    if (members.length < 2) continue;
    sharedNoteGroups++;
    rowsSharingANote += members.length;
    if (members.length > largest.length) {
      largest = members;
      largestNote = note;
    }
  }

  return {
    rowsWithNote: rows.length,
    distinctNotes: byNote.size,
    sharedNoteGroups,
    rowsSharingANote,
    largestGroupSize: largest.length,
    largestGroup:
      largest.length > 0
        ? {
            note: largestNote.slice(0, 120),
            titles: largest.slice(0, 6).map((r) => (r.titleEn ?? '').slice(0, 80)),
          }
        : null,
  };
}

/** Whether each stored row's article arrived TAGGED. Counted from the `mode`
 *  recorded in the `score_components_json` audit — no parallel record, no extra
 *  column.
 *
 *  Named for the routing it used to describe. Since the judge was removed every
 *  row is scored by the LLM, so this is a property of the ARTICLE, not of the
 *  scorer. */
export interface ScoringModeBreakdown {
  /** The article carried geo/entity/event tags (`math`). */
  math: number;
  /** The article was untagged (`backstop`). */
  backstop: number;
  /** Scored, but the audit blob is missing, unparseable, or predates the `mode`
   *  field. Reported rather than folded into either bucket — attributing these
   *  to a path we cannot actually observe is exactly the kind of quiet lie this
   *  diagnostic exists to avoid. */
  unknown: number;
}

/**
 * Count the stored suggestions by whether their article carried server tags.
 *
 * ON-DEMAND ONLY (the Observability screen's refresh). It reads every scored
 * row's audit JSON, so it is deliberately absent from the render, ingest and
 * scroll paths. Read-only.
 *
 * This is how the tagging backfill becomes observable: rows move from
 * `backstop` to `math` as the server starts emitting
 * `geo_tags`/`entities`/`event_type`. Rows scored before the
 * `USE_ARTICLE_TAGS` blanking was removed all read `backstop`, whatever their
 * article actually carried.
 */
export async function getScoringModeBreakdown(): Promise<ScoringModeBreakdown> {
  const out: ScoringModeBreakdown = { math: 0, backstop: 0, unknown: 0 };
  const rows = await articleSuggestionsCol
    .query(Q.where('scored_at', Q.notEq(null)))
    .fetch();
  for (const row of rows) {
    if (!row.scoreComponentsJson) {
      out.unknown++;
      continue;
    }
    try {
      const { mode } = JSON.parse(row.scoreComponentsJson) as RelevanceComponents;
      if (mode === 'math') out.math++;
      else if (mode === 'backstop') out.backstop++;
      else out.unknown++;
    } catch {
      out.unknown++;
    }
  }
  return out;
}
