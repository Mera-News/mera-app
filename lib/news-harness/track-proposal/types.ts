// news-harness — track-proposal types (PURE, RN-free).
//
// The track-proposal pipeline turns an article the user tapped "Track" on into
// ONE sentence describing WHAT to track, phrased as a durable, trackable topic
// (e.g. "Updates on the student protest in Sonbhadra over exam results") — not
// a rehash of the single article that sparked the interest. The user can tweak
// it with a free-text instruction, which re-runs the pipeline with the previous
// proposal + the instruction as context. Data-only so the prompt builder +
// parser stay unit-testable off-device. The proposal is English-canonical and
// rendered downstream via TranslatableDynamic.

/** Inputs for one track-proposal generation call. */
export interface TrackProposalInput {
  /** The tapped article's title (always present). */
  title: string;
  /** The article's description / snippet, when the subject carries one. */
  description?: string | null;
  /** The proposal shown before the user's tweak (revision rounds only). */
  previousProposal?: string | null;
  /** The user's free-text "track something else…" instruction (revision only). */
  userInstruction?: string | null;
}

/** The {system, user} pair for one track-proposal generation call. */
export interface TrackProposalPrompt {
  system: string;
  user: string;
}
