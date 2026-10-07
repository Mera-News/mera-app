import { addCountry, filterAddable, initialArrange, removePage, toDraft } from '@/components/custom/nav/arrange-model';

import { commitWorldDraft, searchCountryOptions, toCountryOptions } from '../world-arrange';

describe('toCountryOptions', () => {
    it('maps the server alpha-3 list to alpha-2 options with English names, dropping GLOBAL and unmappable codes', () => {
        const opts = toCountryOptions(['FRA', 'GLOBAL', 'PYF', 'XKX', 'deu', 'FRA']);
        expect(opts).toEqual([
            { alpha2: 'FR', name: 'France' },
            { alpha2: 'PF', name: 'French Polynesia' },
            { alpha2: 'DE', name: 'Germany' },
        ]);
    });
});

describe('searchCountryOptions', () => {
    const all = toCountryOptions(['FRA', 'PYF', 'SPM', 'DEU', 'AFG', 'ZAF']);

    it('puts names starting with the query first, then names containing it', () => {
        const names = searchCountryOptions(all, 'Fr').map((o) => o.name);
        expect(names).toEqual(['France', 'French Polynesia', 'South Africa']);
    });

    it('offers nothing for an empty query', () => {
        expect(searchCountryOptions(all, '  ')).toEqual([]);
    });

    it('finds a country removed in this draft again, and re-adding it cancels the removal', () => {
        let draft = initialArrange(['world', 'country:DE', 'country:FR']);
        draft = removePage(draft, 'country:DE');
        const offered = filterAddable(searchCountryOptions(all, 'Ger'), draft);
        expect(offered.map((o) => o.alpha2)).toEqual(['DE']);
        draft = addCountry(draft, offered[0]);
        expect(toDraft(draft)).toEqual({ order: ['world', 'country:FR', 'country:DE'], removed: [], added: [] });
    });

    it('never offers a country still in the draft', () => {
        const draft = initialArrange(['world', 'country:FR']);
        expect(filterAddable(searchCountryOptions(all, 'fr'), draft).map((o) => o.alpha2)).toEqual(['PF', 'ZA']);
    });
});

describe('commitWorldDraft', () => {
    const ports = () => ({
        addCountry: jest.fn(async () => {}),
        removeCountry: jest.fn(async () => {}),
        saveOrder: jest.fn(),
    });

    it('removes, adds, then saves the order without removed ids and with unplaced additions appended', async () => {
        const p = ports();
        await commitWorldDraft(
            { order: ['country:DE', 'world', 'country:NL', 'country:IN'], removed: ['country:NL'], added: ['fr'] },
            p,
        );
        expect(p.removeCountry).toHaveBeenCalledWith('NL');
        expect(p.addCountry).toHaveBeenCalledWith('fr');
        expect(p.saveOrder).toHaveBeenCalledWith(['country:DE', 'world', 'country:IN', 'country:FR']);
        expect(p.removeCountry.mock.invocationCallOrder[0]).toBeLessThan(p.addCountry.mock.invocationCallOrder[0]);
        expect(p.addCountry.mock.invocationCallOrder[0]).toBeLessThan(p.saveOrder.mock.invocationCallOrder[0]);
    });

    it('keeps an addition where the overlay placed it', async () => {
        const p = ports();
        await commitWorldDraft({ order: ['world', 'country:FR', 'country:DE'], removed: [], added: ['FR'] }, p);
        expect(p.saveOrder).toHaveBeenCalledWith(['world', 'country:FR', 'country:DE']);
    });

    it('never removes World', async () => {
        const p = ports();
        await commitWorldDraft({ order: ['world'], removed: ['world'], added: [] }, p);
        expect(p.removeCountry).not.toHaveBeenCalled();
        expect(p.saveOrder).toHaveBeenCalledWith(['world']);
    });
});
