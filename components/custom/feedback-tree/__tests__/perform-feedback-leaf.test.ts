// perform-feedback-leaf.test.ts: the subscribe nudge names the publication
// by its display name (ux2 A7); the leaf's context keeps the raw key.

jest.mock('@/components/custom/feedback-tree/apply-leaf-actions', () => ({ applyLeafActions: jest.fn() }));
jest.mock('@/components/custom/feedback-tree/open-publication-preferences', () => ({
  openPublicationPreferences: jest.fn(),
}));
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: () => ({ openArticleFeedback: jest.fn() }) },
}));
jest.mock('@/lib/stores/subscription-store', () => ({ getAiAccess: () => 'full' }));

import { performFeedbackLeaf, type FeedbackLeafDeps } from '../perform-feedback-leaf';
import { usePublicationDisplayStore } from '@/lib/stores/publication-display-store';

function deps(over: Partial<FeedbackLeafDeps> = {}): FeedbackLeafDeps {
  return {
    context: { publicationName: '人民日报' },
    chatContext: {} as FeedbackLeafDeps['chatContext'],
    chatMessage: '',
    label: '',
    spend: { articleId: 'a', sentiment: 'dislike' },
    closeThen: (after) => after?.(),
    onLeafPicked: jest.fn(),
    showInfo: jest.fn(),
    chrome: (_k, def, vars) => (vars?.publication ? `${def} [${String(vars.publication)}]` : def),
    ...over,
  };
}

describe('performFeedbackLeaf: subscribe nudge', () => {
  afterEach(() => usePublicationDisplayStore.setState({ language: null, names: {} }));

  it('names the publication by its display name', () => {
    usePublicationDisplayStore.setState({ language: 'en', names: { '人民日报': 'Renmin Ribao' } });
    const d = deps();
    performFeedbackLeaf({ id: 'sub', labelKey: 'k', labelDefault: 'Sub', leaf: { nudge: 'subscribe' } } as never, ['sub'], d);
    expect(d.showInfo).toHaveBeenCalledWith('Subscribing unlocks full articles [Renmin Ribao]');
  });

  it('falls back to the raw name when no display name is known', () => {
    const d = deps();
    performFeedbackLeaf({ id: 'sub', labelKey: 'k', labelDefault: 'Sub', leaf: { nudge: 'subscribe' } } as never, ['sub'], d);
    expect(d.showInfo).toHaveBeenCalledWith('Subscribing unlocks full articles [人民日报]');
  });
});
