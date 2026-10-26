// The matched-facts line is for a row WITHOUT a reason only (owner): once the reason is written it
// says why on its own, and a facts line under it repeats it. The only fake is the facts query.
import { act, render } from '@testing-library/react-native';
import React from 'react';
import ReasonNote from '@/components/custom/cards/ReasonNote';
import { initI18nEn } from '@/test/helpers';

const mockFacts = jest.fn();
jest.mock('@/lib/database/services/fact-service', () => ({
    ...jest.requireActual('@/lib/database/services/fact-service'),
    getFactsForTopicTexts: (...a: unknown[]) => mockFacts(...a),
}));

beforeAll(initI18nEn);

describe('ReasonNote with a reason', () => {
    it('shows the reason and no matched facts line', async () => {
        mockFacts.mockResolvedValue([{ statement: 'follows arsenal' }]);
        const { getByText, queryByText } = render(
            <ReasonNote relevance={0.8} reason="A transfer story." topicIds={['t-1']} testID="note" maxNoteLines={4} />,
        );
        await act(async () => {});
        expect(getByText('A transfer story.')).toBeTruthy();
        expect(queryByText(/Follows Arsenal/)).toBeNull();
    });
});
