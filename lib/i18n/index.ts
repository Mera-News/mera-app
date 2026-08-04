import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { I18nManager } from 'react-native';

import ar from '@/lib/locales/ar.json';
import de from '@/lib/locales/de.json';
import en from '@/lib/locales/en.json';
import es from '@/lib/locales/es.json';
import fr from '@/lib/locales/fr.json';
import hi from '@/lib/locales/hi.json';
import id from '@/lib/locales/id.json';
import it from '@/lib/locales/it.json';
import ja from '@/lib/locales/ja.json';
import ko from '@/lib/locales/ko.json';
import nl from '@/lib/locales/nl.json';
import pl from '@/lib/locales/pl.json';
import ptBR from '@/lib/locales/pt-BR.json';
import ru from '@/lib/locales/ru.json';
import th from '@/lib/locales/th.json';
import tr from '@/lib/locales/tr.json';
import uk from '@/lib/locales/uk.json';
import vi from '@/lib/locales/vi.json';
import zhCN from '@/lib/locales/zh-CN.json';
import zhTW from '@/lib/locales/zh-TW.json';

export { SUPPORTED_LANGUAGES as APP_LANGUAGES } from '@/lib/translation-service';
export type { SupportedLanguage as AppLanguage } from '@/lib/translation-service';

// RTL languages in iOS's translation list
const RTL_LANGUAGES = new Set(['ar', 'he']);

// Resources are keyed by iOS translation codes so a single `appLanguage` drives
// both i18next and the on-device translator. Codes without a JSON file fall
// back to English via `fallbackLng`.
i18n.use(initReactI18next).init({
    compatibilityJSON: 'v4',
    resources: {
        en:        { translation: en },
        ar:        { translation: ar },
        nl:        { translation: nl },
        fr:        { translation: fr },
        de:        { translation: de },
        hi:        { translation: hi },
        id:        { translation: id },
        it:        { translation: it },
        ja:        { translation: ja },
        ko:        { translation: ko },
        'zh-Hans': { translation: zhCN },
        'zh-Hant': { translation: zhTW },
        pl:        { translation: pl },
        pt:        { translation: ptBR },
        ru:        { translation: ru },
        es:        { translation: es },
        th:        { translation: th },
        tr:        { translation: tr },
        uk:        { translation: uk },
        vi:        { translation: vi },
    },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
});

/**
 * Apply a language to i18n and handle RTL layout for Arabic/Hebrew.
 * Call this after hydrating the app-language store.
 * For RTL changes the caller must trigger an app reload.
 */
export function applyLanguage(lang: string): void {
    i18n.changeLanguage(lang);
    const isRTL = RTL_LANGUAGES.has(lang);
    if (I18nManager.isRTL !== isRTL) {
        I18nManager.forceRTL(isRTL);
    }
}

/**
 * Swap the UI strings and NOTHING else — deliberately not `applyLanguage`.
 *
 * Used while a language switch is still provisional: the user has picked a
 * language but the OS has not finished preparing its translation pack, so the
 * choice may still fail, time out, or be cancelled. The bundled UI strings need
 * no download, so there is no reason to make the reader wait for them — that is
 * the whole point, since the instruction they need ("tap the download icon") is
 * useless in a language they cannot read.
 *
 * What it must NOT do, and why:
 *
 *  - `I18nManager.forceRTL` is a PERSISTED NATIVE FLAG that only takes effect
 *    after a reload. Toggling it for a switch that may be reverted risks the
 *    app being killed mid-probe with the flag saved and `app_language` not —
 *    which is an RTL layout wrapped around LTR strings on next launch. RTL
 *    therefore stays in `applyLanguage`, on the commit path only.
 *  - It does not touch the store or the database. `appLanguage` remains the
 *    language the user is actually on, which is what makes the revert trivial:
 *    re-apply the store's value and the preview is undone.
 *
 * Resources are bundled statically, so this lands synchronously — verified,
 * and relied upon by the failure alerts, which are built immediately after the
 * revert and must come out in the language the user was returned to.
 *
 * See `lib/hooks/use-language-switch.ts` for the state machine that owns this.
 */
export function previewLanguage(lang: string): void {
    i18n.changeLanguage(lang);
}

export default i18n;
