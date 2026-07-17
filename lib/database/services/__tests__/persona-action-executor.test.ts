// persona-action-executor unit tests — dispatch per action_type with every
// underlying service mocked. Verifies each branch routes to the right service,
// appends (or deliberately does NOT append) a change-log row, and returns the
// change-log id where one is written.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(() => 'evt') },
}));

jest.mock('../topic-service', () => ({
  createTopics: jest.fn(async () => [{ id: 't-new' }]),
  retire: jest.fn(async () => {}),
}));

jest.mock('../suppression-service', () => ({
  addSuppression: jest.fn(async () => ({ id: 'sup-1' })),
}));

jest.mock('../location-service', () => ({
  getAll: jest.fn(async () => [{ id: 'loc-1', weight: 0.4 }]),
  setWeight: jest.fn(async () => {}),
}));

jest.mock('../publication-preference-service', () => ({
  getPreferenceKind: jest.fn(async () => 'none'),
  setPreferenceKind: jest.fn(async () => {}),
}));

jest.mock('../persona-change-log-service', () => ({
  append: jest.fn(async () => ({ id: 'cl-1' })),
}));

jest.mock('../mutation-rails-service', () => ({
  nudgeTopic: jest.fn(async () => ({ applied: true, after: 0.5 })),
  setTopicWeightAbsolute: jest.fn(async () => ({
    applied: true,
    before: 0,
    after: 0.5,
    changeLogId: 'cl-abs',
  })),
  setTopicHighPriority: jest.fn(async () => {}),
  nudgeFactWeight: jest.fn(async () => {}),
}));

import { applyPersonaAction, applyPersonaActions } from '../persona-action-executor';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import * as topicService from '../topic-service';
import * as suppressionService from '../suppression-service';
import * as locationService from '../location-service';
import * as pubPrefService from '../publication-preference-service';
import * as changeLogService from '../persona-change-log-service';
import * as mutationRailsService from '../mutation-rails-service';

const append = changeLogService.append as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (pubPrefService.getPreferenceKind as jest.Mock).mockResolvedValue('none');
});

// ---------------------------------------------------------------------------
// set_topic_weight
// ---------------------------------------------------------------------------

describe('set_topic_weight', () => {
  it('delegates to the budget-leashed nudge when a delta is given', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.1 },
      'feedback',
    );
    expect(mutationRailsService.nudgeTopic).toHaveBeenCalledWith('t1', -0.1, 'feedback');
    expect(mutationRailsService.setTopicWeightAbsolute).not.toHaveBeenCalled();
    expect(res.applied).toBe(true);
  });

  it('reports not-applied when the nudge budget is exhausted', async () => {
    (mutationRailsService.nudgeTopic as jest.Mock).mockResolvedValueOnce({
      applied: false,
      after: 0.2,
    });
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.1 },
      'feedback',
    );
    expect(res.applied).toBe(false);
  });

  it('sets an absolute weight (no delta) and surfaces the change-log id', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', weight: 0.5 },
      'feedback',
    );
    expect(mutationRailsService.setTopicWeightAbsolute).toHaveBeenCalledWith('t1', 0.5, 'feedback');
    expect(mutationRailsService.nudgeTopic).not.toHaveBeenCalled();
    expect(res).toMatchObject({ applied: true, changeLogId: 'cl-abs' });
  });

  it('skips when neither delta nor weight is supplied', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1' },
      'feedback',
    );
    expect(res.applied).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// set_high_priority / set_fact_weight
// ---------------------------------------------------------------------------

describe('set_high_priority', () => {
  it('delegates to setTopicHighPriority', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_HIGH_PRIORITY, topicId: 't1', highPriority: true },
      'feedback',
    );
    expect(mutationRailsService.setTopicHighPriority).toHaveBeenCalledWith('t1', true, 'feedback');
    expect(res.applied).toBe(true);
  });
});

describe('set_fact_weight', () => {
  it('delegates to nudgeFactWeight', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_FACT_WEIGHT, factId: 'f1', delta: 0.1 },
      'feedback',
    );
    expect(mutationRailsService.nudgeFactWeight).toHaveBeenCalledWith('f1', 0.1, 'feedback');
    expect(res.applied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// add_negative_topic / add_topic / retire_topic
// ---------------------------------------------------------------------------

describe('add_negative_topic', () => {
  it('mints a negative topic with the default weight and logs it', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC, topicText: 'cricket' },
      'feedback',
    );
    expect(topicService.createTopics).toHaveBeenCalledWith([
      { text: 'cricket', weight: -0.6, status: 'active', provenance: 'feedback' },
    ]);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_NAMES.ADD_NEGATIVE_TOPIC,
        action: { targetId: 't-new', text: 'cricket' },
      }),
    );
    expect(res).toMatchObject({ applied: true, changeLogId: 'cl-1' });
  });

  it('honours an explicit weight', async () => {
    await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC, topicText: 'cricket', weight: -0.9 },
      'feedback',
    );
    expect(topicService.createTopics).toHaveBeenCalledWith([
      { text: 'cricket', weight: -0.9, status: 'active', provenance: 'feedback' },
    ]);
  });

  it('skips (no write) when topicText is missing', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC },
      'feedback',
    );
    expect(res.applied).toBe(false);
    expect(topicService.createTopics).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

describe('add_topic', () => {
  it('mints a positive topic with the default weight and logs it', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_TOPIC, topicText: 'formula 1' },
      'feedback',
    );
    expect(topicService.createTopics).toHaveBeenCalledWith([
      { text: 'formula 1', weight: 0.5, status: 'active', provenance: 'feedback' },
    ]);
    expect(res).toMatchObject({ applied: true, changeLogId: 'cl-1' });
  });
});

describe('retire_topic', () => {
  it('retires the topic and logs it', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_TOPIC, topicId: 't1' },
      'feedback',
    );
    expect(topicService.retire).toHaveBeenCalledWith('t1');
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_NAMES.RETIRE_TOPIC,
        action: { targetId: 't1' },
      }),
    );
    expect(res).toMatchObject({ applied: true, changeLogId: 'cl-1' });
  });
});

// ---------------------------------------------------------------------------
// add_suppression
// ---------------------------------------------------------------------------

describe('add_suppression', () => {
  it('mints a suppression with the default strength and logs it', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'gossip' },
      'feedback',
    );
    expect(suppressionService.addSuppression).toHaveBeenCalledWith({
      pattern: 'gossip',
      keywords: [],
      strength: 0.5,
      source: 'feedback',
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_NAMES.ADD_SUPPRESSION,
        action: { targetId: 'sup-1' },
      }),
    );
    expect(res).toMatchObject({ applied: true, changeLogId: 'cl-1' });
  });
});

// ---------------------------------------------------------------------------
// set_location_weight
// ---------------------------------------------------------------------------

describe('set_location_weight', () => {
  it('sets the weight, logs the prior value, and clamps to [0,1]', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_LOCATION_WEIGHT, locationId: 'loc-1', weight: 1.5 },
      'feedback',
    );
    expect(locationService.setWeight).toHaveBeenCalledWith('loc-1', 1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_NAMES.SET_LOCATION_WEIGHT,
        action: { targetId: 'loc-1', before: 0.4, after: 1 },
      }),
    );
    expect(res).toMatchObject({ applied: true, changeLogId: 'cl-1' });
  });

  it('reports not-applied when the location is unknown', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_LOCATION_WEIGHT, locationId: 'nope', weight: 0.5 },
      'feedback',
    );
    expect(res.applied).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// set_publication_pref (NEW) — apply
// ---------------------------------------------------------------------------

describe('set_publication_pref', () => {
  it('reads the prior kind, sets the new one, and logs before/after', async () => {
    (pubPrefService.getPreferenceKind as jest.Mock).mockResolvedValueOnce('boost');
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'mute' },
      'feedback',
    );
    expect(pubPrefService.getPreferenceKind).toHaveBeenCalledWith('The Times');
    expect(pubPrefService.setPreferenceKind).toHaveBeenCalledWith('The Times', 'mute', 'feedback');
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
        action: { targetId: 'The Times', before: 'boost', after: 'mute' },
      }),
    );
    expect(res).toMatchObject({ applied: true, changeLogId: 'cl-1' });
  });

  it("records before: 'none' when there was no prior preference", async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: 'The Times', publicationPref: 'boost' },
      'user',
    );
    // source 'user' → 'user' provenance
    expect(pubPrefService.setPreferenceKind).toHaveBeenCalledWith('The Times', 'boost', 'user');
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { targetId: 'The Times', before: 'none', after: 'boost' },
      }),
    );
    expect(res.applied).toBe(true);
  });

  it('skips when publicationPref is missing', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: 'The Times' },
      'feedback',
    );
    expect(res.applied).toBe(false);
    expect(pubPrefService.setPreferenceKind).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// nudges — SUGGESTIONS, never mutate / never log
// ---------------------------------------------------------------------------

describe('nudge_* (suggestions)', () => {
  it('nudge_subscribe_publication writes nothing and is not applied', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.NUDGE_SUBSCRIBE_PUBLICATION, publicationId: 'The Times' },
      'feedback',
    );
    expect(res.applied).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });

  it('nudge_browse_related writes nothing and is not applied', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.NUDGE_BROWSE_RELATED, topicText: 'space' },
      'feedback',
    );
    expect(res.applied).toBe(false);
    expect(append).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unsupported / batch
// ---------------------------------------------------------------------------

describe('unsupported action_type', () => {
  it('returns unsupported without throwing or logging', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.MERGE_FACTS },
      'feedback',
    );
    expect(res).toEqual({ applied: false, summary: 'unsupported: merge_facts' });
    expect(append).not.toHaveBeenCalled();
  });
});

describe('applyPersonaActions (batch)', () => {
  it('applies each action best-effort and returns per-action results', async () => {
    const results = await applyPersonaActions(
      [
        { action_type: ACTION_NAMES.RETIRE_TOPIC, topicId: 't1' },
        { action_type: ACTION_NAMES.NUDGE_BROWSE_RELATED, topicText: 'space' },
        { action_type: ACTION_NAMES.MERGE_FACTS },
      ],
      'feedback',
    );
    expect(results).toHaveLength(3);
    expect(results[0].applied).toBe(true);
    expect(results[1].applied).toBe(false);
    expect(results[2]).toMatchObject({ applied: false, summary: 'unsupported: merge_facts' });
  });

  it('one throwing action does not abort the batch (caught → not applied)', async () => {
    (topicService.retire as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    const results = await applyPersonaActions(
      [
        { action_type: ACTION_NAMES.RETIRE_TOPIC, topicId: 't1' },
        { action_type: ACTION_NAMES.SET_HIGH_PRIORITY, topicId: 't2', highPriority: true },
      ],
      'feedback',
    );
    expect(results[0].applied).toBe(false);
    expect(results[1].applied).toBe(true);
  });
});
