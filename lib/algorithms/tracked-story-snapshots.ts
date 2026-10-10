/**
 * A lean, card-renderable snapshot of one member article, remembered so the
 * timeline can render locally-discovered members without a server round trip.
 * `pubDateMs` drives the strict newest-first ordering; the rest degrade
 * gracefully when absent.
 */
export interface TrackedStoryMemberSnapshot {
  articleId: string;
  /** The ENGLISH title (title_en). */
  title: string;
  /** The article's title in its own language (`languageCode`). Absent on
   *  snapshots written before this field existed and on seeds with no
   *  original; the timeline then translates the English instead. Never fill it
   *  with the English: an English "original" beside a `ja` code reads as
   *  already in a Japanese reader's language, so nothing is translated. */
  titleOriginal?: string;
  pubDateMs: number;
  imageUrl?: string;
  publicationName?: string;
  /** Original language of the article — renders the timeline row's language
   *  label. Absent on snapshots written before this field existed. */
  languageCode?: string;
  /** Publisher country — renders the timeline row's source flag. Same caveat. */
  countryCode?: string;
}

/** Coerce the persisted member-snapshot JSON column into a clean array. */
export const sanitizeSnapshots = (raw: unknown): TrackedStoryMemberSnapshot[] =>
  Array.isArray(raw)
    ? raw
        .filter((x): x is TrackedStoryMemberSnapshot => !!x && typeof x === 'object')
        .map((x) => ({
          articleId: String((x as any).articleId ?? ''),
          title: typeof (x as any).title === 'string' ? (x as any).title : '',
          titleOriginal:
            typeof (x as any).titleOriginal === 'string' && (x as any).titleOriginal
              ? (x as any).titleOriginal
              : undefined,
          pubDateMs: Number((x as any).pubDateMs) || 0,
          imageUrl:
            typeof (x as any).imageUrl === 'string' ? (x as any).imageUrl : undefined,
          publicationName:
            typeof (x as any).publicationName === 'string'
              ? (x as any).publicationName
              : undefined,
          languageCode:
            typeof (x as any).languageCode === 'string'
              ? (x as any).languageCode
              : undefined,
          countryCode:
            typeof (x as any).countryCode === 'string'
              ? (x as any).countryCode
              : undefined,
        }))
        .filter((x) => x.articleId.length > 0)
    : [];
