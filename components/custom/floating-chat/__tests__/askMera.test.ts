const mockExpand = jest.fn();
const mockOpenArticleFeedback = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: () => ({ expand: mockExpand, openArticleFeedback: mockOpenArticleFeedback }),
  },
}));

import { askMeraAbout } from '../ask-mera';

describe('askMeraAbout', () => {
  beforeEach(() => {
    mockExpand.mockClear();
    mockOpenArticleFeedback.mockClear();
  });

  it('opens the article chat with the article as its context', () => {
    expect(askMeraAbout({ articleId: 'a1', suggestionId: 's1', title: 'T' })).toBe(true);
    expect(mockExpand).toHaveBeenCalledWith({
      kind: 'article-suggestion',
      articleId: 'a1',
      suggestionId: 's1',
      articleTitle: 'T',
    });
  });

  it('never seeds a message, so opening costs no model call', () => {
    askMeraAbout({ articleId: 'a1' });
    expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
  });

  it('is a no-op without an id', () => {
    expect(askMeraAbout({ title: 'T' })).toBe(false);
    expect(mockExpand).not.toHaveBeenCalled();
  });
});
