// The pod runner reads its two toast keys through a string cast, so the type
// checker cannot catch a missing one. Render them from en.json here.
import { createInstance } from 'i18next';
import en from '@/lib/locales/en.json';

describe('pod toast lines', () => {
    it('renders both from the English dictionary', async () => {
        const i18n = createInstance();
        await i18n.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
        expect(i18n.t('ownServices.pod.toast.unreachable')).toBe("Can't reach your server. Nothing was changed.");
        expect(i18n.t('ownServices.pod.toast.failed')).toBe("Your server couldn't save this. Try again.");
    });
});
