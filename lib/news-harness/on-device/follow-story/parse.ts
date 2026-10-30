import { capWords, text, type OnDeviceToolCall, type OnDeviceTurnResult } from '../shared';
import { normalizeMustMatch } from '../../core/must-match';
import { MAX_OPTION_LABEL_WORDS, MAX_TRACK_SEARCH_WORDS, type FollowStoryReply } from './schema';

/**
 * The options as `proposeTrack` input, word caps applied. The executor
 * (decideProposeTrack) trims, dedupes and caps the count itself.
 */
export function trackOptions(raw: unknown): { label: string; search: string; mustMatch?: string[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => {
      const rec = o as Record<string, unknown>;
      const mustMatch = normalizeMustMatch(rec?.mustMatch);
      return {
        label: capWords(text(rec?.label), MAX_OPTION_LABEL_WORDS),
        search: capWords(text(rec?.search), MAX_TRACK_SEARCH_WORDS),
        ...(mustMatch.length > 0 ? { mustMatch } : {}),
      };
    })
    .filter((o) => o.label.length > 0);
}

/** A `proposeTrack` call staging the options, or none when there are none. */
export function proposeTrackCalls(raw: unknown): OnDeviceToolCall[] {
  const options = trackOptions(raw);
  return options.length > 0 ? [{ name: 'proposeTrack', input: { options } }] : [];
}

export function followStoryTurn(value: FollowStoryReply): OnDeviceTurnResult {
  return { reply: text(value.reply), calls: proposeTrackCalls(value.options) };
}
