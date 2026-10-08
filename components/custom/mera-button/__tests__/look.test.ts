jest.mock('@/lib/stores/display-prefs-store', () => ({ useDisplayPrefsStore: jest.fn() }));

import { COLORS } from '@/lib/theme/tokens';
import { meraButtonColors, resolveMeraButtonLook } from '../look';

describe('Mera button look', () => {
    it('follows the theme until the reader picks', () => {
        expect(resolveMeraButtonLook(null, 'dark')).toBe('light');
        expect(resolveMeraButtonLook(null, 'light')).toBe('dark');
        expect(resolveMeraButtonLook('dark', 'dark')).toBe('dark');
        expect(resolveMeraButtonLook('light', 'light')).toBe('light');
    });

    it('keeps the exact pairs the button wore per theme', () => {
        expect(meraButtonColors('light')).toEqual({ disc: COLORS.dark.ink, mark: COLORS.dark.base });
        expect(meraButtonColors('dark')).toEqual({ disc: COLORS.light.ink, mark: COLORS.light.base });
    });
});
