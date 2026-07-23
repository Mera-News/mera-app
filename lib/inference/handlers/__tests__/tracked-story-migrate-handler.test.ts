// tracked-story-migrate-handler tests — mock the LLM transport + topic/tracked
// services, let the REAL story-scope parser run against a mocked completion.
// Assert the titles → LLM → {label, search} → mint topic + bind + set headline
// flow (cloud + on-device), and non-destructive edge cases (empty payload,
// transport failure, parse failure → no writes).

const mockCloudComplete = jest.fn();
jest.mock('../../../llm/cloudComplete', () => ({
  cloudComplete: (...a: unknown[]) => mockCloudComplete(...a),
}));

const mockCompleteLocal = jest.fn();
jest.mock('../../../llm/completeLocal', () => ({
  completeLocal: (...a: unknown[]) => mockCompleteLocal(...a),
}));

const mockCreateTopics = jest.fn();
jest.mock('../../../database/services/topic-service', () => ({
  createTopics: (...a: unknown[]) => mockCreateTopics(...a),
}));

const mockBindTrackedTopic = jest.fn();
const mockSetLlmHeadline = jest.fn();
jest.mock('../../../database/services/tracked-story-service', () => ({
  bindTrackedTopic: (...a: unknown[]) => mockBindTrackedTopic(...a),
  setLlmHeadline: (...a: unknown[]) => mockSetLlmHeadline(...a),
}));

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import {
  handleTrackedStoryMigrateJob,
  trackedStoryMigrateDedupeKey,
} from '../tracked-story-migrate-handler';

const TITLES = ['Floods hit Assam', 'Assam floods displace thousands'];
const SCOPE_JSON = '{"label":"Assam floods","search":"assam floods displacement"}';

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateTopics.mockResolvedValue([{ id: 'top-1' }]);
  mockBindTrackedTopic.mockResolvedValue(undefined);
  mockSetLlmHeadline.mockResolvedValue(undefined);
});

describe('trackedStoryMigrateDedupeKey', () => {
  it('is namespaced by story id', () => {
    expect(trackedStoryMigrateDedupeKey('story-9')).toBe('tracked_story_migrate:story-9');
  });
});

describe('handleTrackedStoryMigrateJob — cloud', () => {
  it('generates via cloudComplete, mints a topic, binds it, and sets the headline', async () => {
    mockCloudComplete.mockResolvedValue(SCOPE_JSON);

    const result = await handleTrackedStoryMigrateJob({
      trackedStoryId: 'story-1',
      titles: TITLES,
      useCloud: true,
    });

    expect(mockCloudComplete).toHaveBeenCalled();
    expect(mockCompleteLocal).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(mockCreateTopics).toHaveBeenCalledWith([
      expect.objectContaining({
        text: 'assam floods displacement',
        weight: 0.85,
        status: 'active',
        provenance: 'tracked',
        highPriority: true,
      }),
    ]);
    expect(mockBindTrackedTopic).toHaveBeenCalledWith(
      'story-1',
      'top-1',
      'assam floods displacement',
    );
    expect(mockSetLlmHeadline).toHaveBeenCalledWith('story-1', 'Assam floods');
  });

  it('binds a null topic id when the mint returns nothing', async () => {
    mockCloudComplete.mockResolvedValue(SCOPE_JSON);
    mockCreateTopics.mockResolvedValue([]);

    const result = await handleTrackedStoryMigrateJob({
      trackedStoryId: 'story-1',
      titles: TITLES,
      useCloud: true,
    });

    expect(result.ok).toBe(true);
    expect(mockBindTrackedTopic).toHaveBeenCalledWith(
      'story-1',
      null,
      'assam floods displacement',
    );
  });
});

describe('handleTrackedStoryMigrateJob — on-device', () => {
  it('generates via completeLocal and performs the same writes', async () => {
    mockCompleteLocal.mockResolvedValue(SCOPE_JSON);

    const result = await handleTrackedStoryMigrateJob({
      trackedStoryId: 'story-2',
      titles: TITLES,
    });

    expect(mockCompleteLocal).toHaveBeenCalled();
    expect(mockCloudComplete).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(mockBindTrackedTopic).toHaveBeenCalledWith(
      'story-2',
      'top-1',
      'assam floods displacement',
    );
    expect(mockSetLlmHeadline).toHaveBeenCalledWith('story-2', 'Assam floods');
  });
});

describe('handleTrackedStoryMigrateJob — non-destructive edge cases', () => {
  it('empty titles → no completion, no writes', async () => {
    const result = await handleTrackedStoryMigrateJob({ trackedStoryId: 'story-3', titles: [] });
    expect(result.ok).toBe(false);
    expect(mockCloudComplete).not.toHaveBeenCalled();
    expect(mockCompleteLocal).not.toHaveBeenCalled();
    expect(mockCreateTopics).not.toHaveBeenCalled();
    expect(mockBindTrackedTopic).not.toHaveBeenCalled();
    expect(mockSetLlmHeadline).not.toHaveBeenCalled();
  });

  it('missing story id → no writes', async () => {
    const result = await handleTrackedStoryMigrateJob({ trackedStoryId: '', titles: TITLES });
    expect(result.ok).toBe(false);
    expect(mockCreateTopics).not.toHaveBeenCalled();
  });

  it('transport failure → no writes (story stays legacy)', async () => {
    mockCloudComplete.mockRejectedValue(new Error('network'));

    const result = await handleTrackedStoryMigrateJob({
      trackedStoryId: 'story-4',
      titles: TITLES,
      useCloud: true,
    });

    expect(result.ok).toBe(false);
    expect(mockCreateTopics).not.toHaveBeenCalled();
    expect(mockBindTrackedTopic).not.toHaveBeenCalled();
    expect(mockSetLlmHeadline).not.toHaveBeenCalled();
  });

  it('parse failure (garbage) → no writes', async () => {
    mockCloudComplete.mockResolvedValue('sorry, I cannot help with that');

    const result = await handleTrackedStoryMigrateJob({
      trackedStoryId: 'story-5',
      titles: TITLES,
      useCloud: true,
    });

    expect(result.ok).toBe(false);
    expect(mockCreateTopics).not.toHaveBeenCalled();
    expect(mockBindTrackedTopic).not.toHaveBeenCalled();
    expect(mockSetLlmHeadline).not.toHaveBeenCalled();
  });
});
