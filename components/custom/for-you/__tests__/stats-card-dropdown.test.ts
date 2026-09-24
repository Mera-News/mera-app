import { DROPDOWN_EDGE_GAP, dropdownFrame } from '../stats-card-dropdown';

// 375x667 (iPhone SE class): status bar 20, in-tab bottom inset 49 (bar, no
// home indicator). The card sits under a ~183pt header.
const SE = { windowHeight: 667, topInset: 20, bottomReserve: 49 };

describe('dropdownFrame', () => {
    it('sits directly under the card, the card\'s width', () => {
        const f = dropdownFrame({ x: 12, y: 195, width: 351, height: 64 }, SE.windowHeight, SE.topInset, SE.bottomReserve);
        expect(f).toEqual({ top: 259, left: 12, width: 351, maxHeight: 667 - 49 - DROPDOWN_EDGE_GAP - 259 });
    });

    it('never rises into the status bar when the card is scrolled partly off the top', () => {
        const f = dropdownFrame({ x: 12, y: -40, width: 351, height: 50 }, SE.windowHeight, SE.topInset, SE.bottomReserve);
        expect(f.top).toBe(SE.topInset + DROPDOWN_EDGE_GAP);
    });

    it('stops above the tab bar', () => {
        const f = dropdownFrame({ x: 12, y: 195, width: 351, height: 64 }, SE.windowHeight, SE.topInset, SE.bottomReserve);
        expect(f.top + f.maxHeight).toBe(SE.windowHeight - SE.bottomReserve - DROPDOWN_EDGE_GAP);
    });

    it('never reports a negative height', () => {
        const f = dropdownFrame({ x: 0, y: 600, width: 375, height: 60 }, SE.windowHeight, SE.topInset, SE.bottomReserve);
        expect(f.maxHeight).toBe(0);
    });
});
