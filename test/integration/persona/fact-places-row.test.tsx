/** The fact page's About row at its component seam: chips, remove, Anywhere, and the country picker. */
import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { FactPlacesRow } from '@/components/custom/facts/FactPlacesRow';
import { setFactPlaces } from '@/lib/database/services/fact-service';
import { initI18nEn } from '@/test/helpers';

jest.mock('@/lib/database/services/fact-service', () => ({ setFactPlaces: jest.fn().mockResolvedValue({ applied: true }) }));

// The kit sheet is a Modal plus Reanimated motion; the seam here is what the picker puts in it.
jest.mock('@/components/ui/bottom-sheet', () => ({
    BottomSheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <>{children}</> : null),
}));

const fact = (places: string[]) => ({ statement: 'Follows Bhopal news', metadata: { places } });
const mount = (places: string[]) => render(<FactPlacesRow factId="f1" fact={fact(places)} />);

beforeAll(initI18nEn);
beforeEach(() => jest.mocked(setFactPlaces).mockClear());

describe('FactPlacesRow', () => {
    it('shows one chip per place, labelled with the place name', () => {
        mount(['IN|Madhya Pradesh|Bhopal']);
        expect(screen.getByText('Bhopal')).toBeTruthy();
        expect(screen.getByLabelText('Bhopal, Madhya Pradesh, India')).toBeTruthy();
    });

    it('removes a chip with its x, as the user', () => {
        mount(['IN|Madhya Pradesh|Bhopal', 'FR']);
        fireEvent.press(screen.getByTestId('fact-place-remove-FR'));
        expect(setFactPlaces).toHaveBeenCalledWith('f1', ['IN|Madhya Pradesh|Bhopal'], 'user');
    });

    it('Anywhere writes GLOBAL and is hidden once the fact is Anywhere', () => {
        const view = mount(['FR']);
        fireEvent.press(screen.getByTestId('fact-place-anywhere'));
        expect(setFactPlaces).toHaveBeenCalledWith('f1', ['GLOBAL'], 'user');
        view.rerender(<FactPlacesRow factId="f1" fact={fact(['GLOBAL'])} />);
        expect(screen.queryByTestId('fact-place-anywhere')).toBeNull();
    });

    it('a picked country joins the places and replaces GLOBAL', () => {
        mount(['GLOBAL']);
        fireEvent.press(screen.getByTestId('fact-place-add'));
        fireEvent.changeText(screen.getByTestId('country-picker-search'), 'Fran');
        fireEvent.press(screen.getByTestId('country-pick-FR'));
        expect(setFactPlaces).toHaveBeenCalledWith('f1', ['FR'], 'user');
    });
});
