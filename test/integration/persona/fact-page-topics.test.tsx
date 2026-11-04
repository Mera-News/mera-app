// The fact page says what Suggest more did and which line a fact with no topics gets. The real
// screen and hook, faked at the data edges.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import FactPage from '@/components/custom/facts/FactPage';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn } from '@/test/helpers';

const mockGenerate = jest.fn();
const mockRelease = jest.fn();
const mockRetry = jest.fn();
let mockFact: Record<string, unknown> | null = null;
let mockTopics: Record<string, unknown>[] = [];

jest.mock('@/lib/database/services/topic-planning-service', () => ({
    generateMoreAndWait: (...a: unknown[]) => mockGenerate(...a),
    holdFactOnScreen: () => mockRelease,
}));
jest.mock('@/lib/chat-tools/tool-handlers', () => ({ retryTopicGeneration: (...a: unknown[]) => mockRetry(...a) }));
jest.mock('@/lib/database/services/fact-service', () => ({
    ...jest.requireActual('@/lib/database/services/fact-service'),
    observeFact: () => require('rxjs').of(mockFact),
}));
jest.mock('@/lib/database/services/topic-service', () => ({
    ...jest.requireActual('@/lib/database/services/topic-service'),
    observeByFact: () => require('rxjs').of(mockTopics),
}));
jest.mock('@/lib/database/services/topic-decline-service', () => ({
    ...jest.requireActual('@/lib/database/services/topic-decline-service'),
    listDeclinedTopics: () => require('rxjs').of([]),
}));
jest.mock('@/components/custom/for-you/use-section-snapshots', () => ({ useSectionSnapshots: () => null }));
jest.mock('@/components/custom/feed/use-session-geo-context', () => ({ useSessionGeoLanguageContext: () => ({}) }));
jest.mock('@/lib/user-context/user-geo-language-context', () => ({ useUserGeoLanguageContext: () => ({}) }));
jest.mock('@/lib/hooks/use-open-suggestion', () => ({ useOpenSuggestion: () => jest.fn() }));
jest.mock('@/lib/stores/selectors', () => ({ useForYouSuggestions: () => [] }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => () => null);
jest.mock('@/components/custom/MeraLogo', () => () => null);
// The preset cannot load RN's Modal, and none of these are under test.
jest.mock('@/components/ui/bottom-sheet', () => ({ BottomSheet: () => null }));
jest.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
jest.mock('@/components/custom/facts/AddTopicModal', () => () => null);
jest.mock('@/components/custom/facts/FactPlacesRow', () => ({ FactPlacesRow: () => null }));
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => {
    const { Text } = require('react-native');
    return function EmptyState({ body }: { body: string }) {
        return <Text testID="fact-topics-empty">{body}</Text>;
    };
});

beforeAll(initI18nEn);
beforeEach(() => {
    jest.clearAllMocks();
    mockTopics = [];
    mockFact = { id: 'f1', statement: 's', metadata: { topics_empty_since: 1 }, weight: null, topicsStatus: 'done' };
    jest.spyOn(toastManager, 'showInfo').mockImplementation(() => {});
    jest.spyOn(toastManager, 'showError').mockImplementation(() => {});
});

const open = async () => {
    const view = await render(
        <GestureHandlerRootView>
            <FactPage factId="f1" from="you" statement="s" />
        </GestureHandlerRootView>,
    );
    await act(async () => {});
    return view;
};
const emptyText = (view: Awaited<ReturnType<typeof open>>) => view.getByTestId('fact-topics-empty').props.children;

describe('a fact with no topics', () => {
    it('says Mera may remove a removable fact, and offers Find topics', async () => {
        const view = await open();
        expect(emptyText(view)).toMatch(/remove this fact/);
        expect(view.getByText('Find topics')).toBeTruthy();
    });

    it('gives a guarded fact the plain line', async () => {
        mockFact = { ...mockFact, metadata: { topics_empty_since: 1, news_stopped: true } };
        const view = await open();
        expect(emptyText(view)).toBe('Saved. No topics to add right now.');
    });

    it('on an error says only that, with a visible Retry, never the saved line beside it', async () => {
        mockFact = { ...mockFact, metadata: {}, topicsStatus: 'error' };
        const view = await open();
        expect(emptyText(view)).toBe('');
        expect(view.getByTestId('fact-topics-retry').props.accessibilityLabel).toBe("Couldn't find topics. Retry");
        expect(view.getByText("Couldn't find topics. Retry")).toBeTruthy();
        await act(async () => { fireEvent.press(view.getByTestId('fact-topics-retry')); });
        expect(mockRetry).toHaveBeenCalledWith('f1', 's');
    });
});

describe('Suggest more', () => {
    beforeEach(() => {
        mockTopics = [{ id: 't1', text: 'Topic', status: 'active', weight: 1 }];
    });

    it.each([
        [{ mode: 'inline', added: 2 }, 'Added 2 topics'],
        [{ mode: 'inline', added: 1 }, 'Added 1 topic'],
        [{ mode: 'queued', added: 0 }, 'Nothing new to add right now'],
    ])('%j is a plain toast and an announcement', async (out, line) => {
        const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
        mockGenerate.mockResolvedValue(out);
        const view = await open();
        await act(async () => { fireEvent.press(view.getByTestId('fact-suggest-more')); });
        expect(toastManager.showInfo).toHaveBeenCalledWith(line);
        expect(toastManager.showError).not.toHaveBeenCalled();
        expect(announce).toHaveBeenCalledWith(line);
    });

    it('a failure is the error toast, and the control is back', async () => {
        mockGenerate.mockResolvedValue({ mode: 'skipped', added: 0 });
        const view = await open();
        await act(async () => { fireEvent.press(view.getByTestId('fact-suggest-more')); });
        expect(toastManager.showError).toHaveBeenCalledWith(expect.any(String), "Couldn't find topics. Try again.");
        expect(view.getByTestId('fact-suggest-more')).toBeTruthy();
    });

    it('swaps the control for the working state while running', async () => {
        mockGenerate.mockReturnValue(new Promise(() => {}));
        const view = await open();
        await act(async () => { fireEvent.press(view.getByTestId('fact-suggest-more')); });
        expect(view.queryByTestId('fact-suggest-more')).toBeNull();
        expect(view.getByTestId('fact-suggesting')).toBeTruthy();
    });
});
