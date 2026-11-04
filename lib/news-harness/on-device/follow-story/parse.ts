import { capWords, text, type OnDeviceToolCall, type OnDeviceTurnResult } from '../shared';
import { phraseKey, withReaderPhrase } from './reader-phrase';
import { MAX_OPTION_LABEL_WORDS, MAX_TRACK_SEARCH_WORDS, type FollowStoryReply } from './schema';

/** The reader's turn, for the exact phrase on the card. An article follow passes none. */
export interface ReaderTurn {
  message: string;
  appIsEnglish: boolean;
}

const capped = (o: unknown): { label: string; search: string } => ({
  label: capWords(text((o as Record<string, unknown>)?.label), MAX_OPTION_LABEL_WORDS),
  search: capWords(text((o as Record<string, unknown>)?.search), MAX_TRACK_SEARCH_WORDS),
});

/**
 * The options as `proposeTrack` input, word caps applied. The executor
 * (decideProposeTrack) trims, dedupes and caps the count itself.
 */
export function trackOptions(raw: unknown): { label: string; search: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(capped).filter((o) => o.label.length > 0);
}

/** A `proposeTrack` call staging the options, or none when there are none. The phrase rows skip the word caps. */
export function proposeTrackCalls(raw: unknown, reader?: ReaderTurn): OnDeviceToolCall[] {
  const card = reader ? withReaderPhrase(raw, reader.message, reader.appIsEnglish) : null;
  if (card) {
    const options = card.options.map((o) => (card.hints.phraseRoles[phraseKey(o.label)] ? o : capped(o)));
    return [{ name: 'proposeTrack', input: { options, phraseCard: card.hints } }];
  }
  const options = trackOptions(raw);
  return options.length > 0 ? [{ name: 'proposeTrack', input: { options } }] : [];
}

export function followStoryTurn(value: FollowStoryReply, reader?: ReaderTurn): OnDeviceTurnResult {
  return { reply: text(value.reply), calls: proposeTrackCalls(value.options, reader) };
}
