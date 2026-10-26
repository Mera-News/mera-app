// The reason box keeps the matched facts under the model sentence: the sentence often names no fact,
// and a reader who sees only it asks "why is this recommended?". The only fake is the facts query.
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import ReasonNote from '@/components/custom/cards/ReasonNote';
import { initI18nEn } from '@/test/helpers';

const mockFacts = jest.fn();
jest.mock('@/lib/database/services/fact-service', () => ({
    ...jest.requireActual('@/lib/database/services/fact-service'),
    getFactsForTopicTexts: (...a: unknown[]) => mockFacts(...a),
}));

beforeAll(initI18nEn);

const fact = (statement: string) => ({ statement });

describe('ReasonNote with a reason', () => {
    it('shows the reason and the matched facts line under it', async () => {
        mockFacts.mockResolvedValue([fact('follows arsenal'), fact('lives in amsterdam')]);
        const { getByTestId, getByText } = render(
            <ReasonNote relevance={0.8} reason="A transfer story." topicIds={['t-1']} testID="note" maxNoteLines={4} />,
        );
        expect(getByText('A transfer story.')).toBeTruthy();
        await waitFor(() => expect(getByTestId('note-facts')).toBeTruthy());
        expect(getByTestId('note-facts').props.children).toBe('Matched your facts: Follows Arsenal · Lives In Amsterdam');
        expect(getByTestId('note-facts').props.numberOfLines).toBe(1);
    });

    it('renders no facts line when nothing matched', async () => {
        mockFacts.mockResolvedValue([]);
        const { queryByTestId, getByText } = render(<ReasonNote relevance={0.8} reason="A transfer story." topicIds={['t-2']} testID="note" />);
        await waitFor(() => expect(mockFacts).toHaveBeenCalled());
        expect(getByText('A transfer story.')).toBeTruthy();
        expect(queryByTestId('note-facts')).toBeNull();
    });
});
