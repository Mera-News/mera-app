// The chat topics card says what "Find more" did: added, nothing new, failed; and which empty line
// a fact with no topics gets. Faked at the edges: the generate call and the two observables.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import ChatTopicsCard from '@/components/custom/floating-chat/ChatTopicsCard';
import { initI18nEn } from '@/test/helpers';

const mockGenerate = jest.fn();
const mockHold = jest.fn();
const mockRelease = jest.fn();
let mockFact: Record<string, unknown> = {};
jest.mock('@/lib/database/services/topic-planning-service', () => ({
    generateMoreAndWait: (...a: unknown[]) => mockGenerate(...a),
    holdFactOnScreen: (...a: unknown[]) => { mockHold(...a); return mockRelease; },
}));
jest.mock('@/lib/database/services/topic-service', () => ({ observeByFact: () => require('rxjs').of([]) }));
jest.mock('@/lib/database/services/fact-service', () => ({
    ...jest.requireActual('@/lib/database/services/fact-service'),
    observeTopicsStatus: () => require('rxjs').of('done'),
    observeFact: () => require('rxjs').of(mockFact),
}));

beforeAll(initI18nEn);
beforeEach(() => {
    mockGenerate.mockReset();
    mockFact = { id: 'f1', statement: 's', metadata: {}, weight: null };
});

const open = async () => {
    const view = await render(<ChatTopicsCard factId="f1" factStatement="s" />);
    await act(async () => {});
    await act(async () => { fireEvent.press(view.getByTestId('chat-topics-header-f1')); });
    return view;
};

describe('ChatTopicsCard find more', () => {
    it.each([
        [{ mode: 'inline', added: 3 }, 'Added 3 topics'],
        [{ mode: 'inline', added: 1 }, 'Added 1 topic'],
        [{ mode: 'queued', added: 0 }, 'Nothing new to add right now'],
        [{ mode: 'skipped', added: 0 }, "Couldn't find topics. Try again."],
    ])('maps %j to its line', async (out, line) => {
        mockGenerate.mockResolvedValue(out);
        const view = await open();
        await act(async () => { fireEvent.press(view.getByTestId('chat-topics-more-f1')); });
        expect(view.getByTestId('chat-topics-more-result').props.children).toBe(line);
    });

    it('clears the old line and disables the control while running, and announces every result', async () => {
        const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
        mockGenerate.mockResolvedValueOnce({ mode: 'inline', added: 0 });
        const view = await open();
        await act(async () => { fireEvent.press(view.getByTestId('chat-topics-more-f1')); });
        expect(announce).toHaveBeenLastCalledWith('Nothing new to add right now');

        let finish: (v: unknown) => void = () => {};
        mockGenerate.mockReturnValueOnce(new Promise((r) => { finish = r; }));
        await act(async () => { fireEvent.press(view.getByTestId('chat-topics-more-f1')); });
        expect(view.queryByTestId('chat-topics-more-result')).toBeNull();
        expect(view.getByTestId('chat-topics-more-f1').props.accessibilityState).toMatchObject({ disabled: true });

        await act(async () => { finish({ mode: 'inline', added: 2 }); });
        expect(announce).toHaveBeenLastCalledWith('Added 2 topics');
    });

    it('holds the fact on screen and releases it on unmount', async () => {
        const view = await open();
        expect(mockHold).toHaveBeenCalledWith('f1');
        await act(async () => { view.unmount(); });
        expect(mockRelease).toHaveBeenCalled();
    });

    it('reads Find topics at zero topics', async () => {
        const view = await open();
        expect(view.getByText('Find topics')).toBeTruthy();
    });
});

describe('ChatTopicsCard empty line', () => {
    it('says Mera may remove a fact that is removable', async () => {
        mockFact = { id: 'f1', statement: 's', metadata: { topics_empty_since: 1 }, weight: null };
        const view = await open();
        expect(view.getByTestId('chat-topics-empty').props.children).toMatch(/remove this fact/);
    });
    it('gives a guarded fact the plain line', async () => {
        mockFact = { id: 'f1', statement: 's', metadata: { topics_empty_since: 1, topics_keep: true }, weight: null };
        const view = await open();
        expect(view.getByTestId('chat-topics-empty').props.children).toBe('Saved. No topics to add right now.');
    });
});
