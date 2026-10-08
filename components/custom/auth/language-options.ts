// The languages the one language selector offers (LanguageSelector.tsx):
// English and those this phone can translate into (owner rule: a language the
// phone cannot translate into is never offered), the phone's own first and
// English second. Settings passes the language the app is IN as `current`, so
// it is always listed: a reader never finds their own language missing.
// First launch passes null, so its list stays strictly filtered.
import { canTranslateIntoLanguage, SUPPORTED_LANGUAGES } from '@/lib/translation-service';

export function offeredLanguages(phone: string, current: string | null) {
    const offered = SUPPORTED_LANGUAGES.filter(
        (l) => l.code === 'en' || l.code === current || canTranslateIntoLanguage(l.code),
    );
    const rank = (code: string) => (code === phone ? 0 : code === 'en' ? 1 : 2);
    return [...offered].sort((a, b) => rank(a.code) - rank(b.code));
}
