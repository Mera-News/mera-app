// story-headline-handler tests — mock the tracked-story service + LLM transport,
// assert the titles → LLM → strict-JSON → write flow (cloud + on-device success,
// invalid payload, transport failure, parse failure → leave fallback).

const mockSetLlmHeadline = jest.fn();
jest.mock('../../../database/services/tracked-story-service', () => ({
  setLlmHeadline: (...a: unknown[]) => mockSetLlmHeadline(...a),
}));

const mockCloudComplete = jest.fn();
jest.mock('../../../llm/cloudComplete', () => ({
  cloudComplete: (...a: unknown[]) => mockCloudComplete(...a),
}));

const mockCompleteLocal = jest.fn();
jest.mock('../../../llm/completeLocal', () => ({
  completeLocal: (...a: unknown[]) => mockCompleteLocal(...a),
}));

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import {
  handleStoryHeadlineJob,
  storyHeadlineDedupeKey,
} from '../story-headline-handler';

const TITLES = ['Floods hit Assam', 'Assam floods displace thousands'];

beforeEach(() => {
  jest.clearAllMocks();
  mockSetLlmHeadline.mockResolvedValue(undefined);
});

describe('storyHeadlineDedupeKey', () => {
  it('is namespaced by story id', () => {
    expect(storyHeadlineDedupeKey('story-9')).toBe('story_headline:story-9');
  });
});

describe('handleStoryHeadlineJob — cloud', () => {
  it('generates via cloudComplete and writes the headline', async () => {
    mockCloudComplete.mockResolvedValue('{"headline":"Assam floods displace thousands"}');

    const result = await handleStoryHeadlineJob({
      trackedStoryId: 'story-1',
      titles: TITLES,
      useCloud: true,
    });

    expect(mockCloudComplete).toHaveBeenCalled();
    expect(mockCompleteLocal).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(mockSetLlmHeadline).toHaveBeenCalledWith(
      'story-1',
      'Assam floods displace thousands',
    );
  });
});

describe('handleStoryHeadlineJob — on-device', () => {
  it('generates via completeLocal and writes the headline', async () => {
    mockCompleteLocal.mockResolvedValue('{"headline":"Assam floods"}');

    const result = await handleStoryHeadlineJob({
      trackedStoryId: 'story-2',
      titles: TITLES,
    });

    expect(mockCompleteLocal).toHaveBeenCalled();
    expect(mockCloudComplete).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(mockSetLlmHeadline).toHaveBeenCalledWith('story-2', 'Assam floods');
  });
});

describe('handleStoryHeadlineJob — non-destructive edge cases', () => {
  it('invalid payload (no titles) → no completion, no write', async () => {
    const result = await handleStoryHeadlineJob({ trackedStoryId: 'story-3', titles: [] });
    expect(result.ok).toBe(false);
    expect(mockCloudComplete).not.toHaveBeenCalled();
    expect(mockCompleteLocal).not.toHaveBeenCalled();
    expect(mockSetLlmHeadline).not.toHaveBeenCalled();
  });

  it('invalid payload (no story id) → no write', async () => {
    const result = await handleStoryHeadlineJob({ trackedStoryId: '', titles: TITLES });
    expect(result.ok).toBe(false);
    expect(mockSetLlmHeadline).not.toHaveBeenCalled();
  });

  it('transport failure → keeps the fallback (no write)', async () => {
    mockCloudComplete.mockRejectedValue(new Error('network'));
    const result = await handleStoryHeadlineJob({
      trackedStoryId: 'story-4',
      titles: TITLES,
      useCloud: true,
    });
    expect(result.ok).toBe(false);
    expect(mockSetLlmHeadline).not.toHaveBeenCalled();
  });

  it('parse failure (garbage) → keeps the fallback (no write)', async () => {
    mockCloudComplete.mockResolvedValue('sorry, I cannot help with that');
    const result = await handleStoryHeadlineJob({
      trackedStoryId: 'story-5',
      titles: TITLES,
      useCloud: true,
    });
    expect(result.ok).toBe(false);
    expect(mockSetLlmHeadline).not.toHaveBeenCalled();
  });
});
