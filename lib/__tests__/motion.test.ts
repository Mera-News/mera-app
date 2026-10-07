import { I18nManager } from 'react-native';

import { inlineSign, inlineX } from '../motion';

// Reanimated's native side does not load in jest; motion.ts only builds easings from it.
jest.mock('react-native-reanimated', () => {
    const f = () => () => 0;
    return { Easing: { bezier: f, in: f, cubic: () => 0, linear: () => 0 } };
});

describe('inline direction', () => {
    const original = I18nManager.isRTL;
    afterEach(() => {
        (I18nManager as { isRTL: boolean }).isRTL = original;
    });

    it('is +1 in LTR, both modes', () => {
        (I18nManager as { isRTL: boolean }).isRTL = false;
        expect(inlineSign()).toBe(1);
        expect(inlineSign('physical')).toBe(1);
        expect(inlineX(12)).toBe(12);
    });

    it('mirrors logical offsets in RTL and never physical ones', () => {
        (I18nManager as { isRTL: boolean }).isRTL = true;
        expect(inlineSign()).toBe(-1);
        expect(inlineX(12)).toBe(-12);
        expect(inlineSign('physical')).toBe(1);
        expect(inlineX(12, 'physical')).toBe(12);
    });
});
