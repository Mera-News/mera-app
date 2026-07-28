import { resolveTopicLabel } from '../resolve-topic-label';
import type { LocalFeedbackContext } from '../types';

const ctx = (over: Partial<LocalFeedbackContext> = {}): LocalFeedbackContext => ({ ...over });

describe('resolveTopicLabel', () => {
  it('returns null when there are no matched topics', () => {
    expect(resolveTopicLabel(ctx())).toBeNull();
    expect(resolveTopicLabel(ctx({ matchedTopics: [] }))).toBeNull();
  });

  it('returns null when matched topics are all synthetic (null topicId)', () => {
    expect(
      resolveTopicLabel(ctx({ matchedTopics: [{ topicId: null, text: 'Breaking headline' }] })),
    ).toBeNull();
  });

  it('returns null when the only real topic has empty/whitespace text', () => {
    expect(resolveTopicLabel(ctx({ matchedTopics: [{ topicId: 't1', text: '   ' }] }))).toBeNull();
  });

  it('names a single real matched topic with extraCount 0', () => {
    expect(
      resolveTopicLabel(ctx({ matchedTopics: [{ topicId: 't1', text: 'Formula 1' }] })),
    ).toEqual({ text: 'Formula 1', extraCount: 0 });
  });

  it('picks the FIRST real topic and counts the rest, ignoring synthetic entries', () => {
    expect(
      resolveTopicLabel(
        ctx({
          matchedTopics: [
            { topicId: null, text: 'Synthetic headline' },
            { topicId: 't1', text: 'Formula 1' },
            { topicId: 't2', text: 'Motorsport' },
            { topicId: 't3', text: 'Monaco Grand Prix' },
          ],
        }),
      ),
    ).toEqual({ text: 'Formula 1', extraCount: 2 });
  });

  it('trims surrounding whitespace on the chosen topic text', () => {
    expect(
      resolveTopicLabel(ctx({ matchedTopics: [{ topicId: 't1', text: '  Formula 1  ' }] })),
    ).toEqual({ text: 'Formula 1', extraCount: 0 });
  });
});
