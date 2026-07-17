import { resolveLeafActions } from '../resolve-leaf-actions';
import { ACTION_NAMES } from '../../persona-management/action-names';
import type { FeedbackTreeLeaf, LocalFeedbackContext } from '../types';

const ctx = (over: Partial<LocalFeedbackContext> = {}): LocalFeedbackContext => ({ ...over });

describe('resolveLeafActions', () => {
  it('no actions → empty', () => {
    expect(resolveLeafActions(undefined, ctx())).toEqual([]);
    expect(resolveLeafActions({}, ctx())).toEqual([]);
    expect(resolveLeafActions({ nudge: 'subscribe' }, ctx())).toEqual([]);
  });

  it('set_publication_pref uses the publication NAME as target', () => {
    const leaf: FeedbackTreeLeaf = { actions: [{ type: 'set_publication_pref', value: 'mute' }] };
    expect(resolveLeafActions(leaf, ctx({ publicationName: 'The Daily' }))).toEqual([
      { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: 'The Daily', publicationPref: 'mute' },
    ]);
  });

  it('set_publication_pref skips without a publication name or with a bad value', () => {
    const leaf: FeedbackTreeLeaf = { actions: [{ type: 'set_publication_pref', value: 'deprioritize' }] };
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
    const bad: FeedbackTreeLeaf = { actions: [{ type: 'set_publication_pref', value: 'nonsense' }] };
    expect(resolveLeafActions(bad, ctx({ publicationName: 'X' }))).toEqual([]);
  });

  it('add_negative_topic fills from_context_geo', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'add_negative_topic', text: 'from_context_geo', weight: -0.6 }],
    };
    expect(resolveLeafActions(leaf, ctx({ geoText: 'Mumbai' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC, topicText: 'Mumbai', weight: -0.6 },
    ]);
    // missing geo → skipped
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
  });

  it('set_topic_weight (matched) yields one action per matched topic id', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }],
    };
    const out = resolveLeafActions(
      leaf,
      ctx({ matchedTopics: [{ topicId: 't1', text: 'a' }, { topicId: null, text: 'b' }, { topicId: 't2', text: 'c' }] }),
    );
    expect(out).toEqual([
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.15 },
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't2', delta: -0.15 },
    ]);
  });

  it('set_topic_weight (from_selection) prefers explicit selection, falls back to matched', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'set_topic_weight', topics: 'from_selection', delta: -0.2 }],
    };
    const sel = resolveLeafActions(
      leaf,
      ctx({ selectedTopicIds: ['s1'], matchedTopics: [{ topicId: 't1', text: 'a' }] }),
    );
    expect(sel).toEqual([{ action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 's1', delta: -0.2 }]);

    const fallback = resolveLeafActions(leaf, ctx({ matchedTopics: [{ topicId: 't1', text: 'a' }] }));
    expect(fallback).toEqual([{ action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.2 }]);
  });

  it('add_suppression fills from_context_title', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'add_suppression', pattern: 'from_context_title', strength: 0.5 }],
    };
    expect(resolveLeafActions(leaf, ctx({ articleTitle: '  Crypto crashes again  ' }))).toEqual([
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'Crypto crashes again', suppressionStrength: 0.5 },
    ]);
    expect(resolveLeafActions(leaf, ctx())).toEqual([]);
  });

  it('unknown action type is ignored (forward-compat)', () => {
    const leaf: FeedbackTreeLeaf = {
      actions: [{ type: 'teleport_user' }, { type: 'set_publication_pref', value: 'mute' }],
    };
    expect(resolveLeafActions(leaf, ctx({ publicationName: 'X' }))).toEqual([
      { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: 'X', publicationPref: 'mute' },
    ]);
  });
});
