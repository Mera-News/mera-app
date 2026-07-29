// Dashboard section TITLES. Pure (no React), so both the sections feed and its
// tests can call it directly.
//
// A fact section's title is user data (the fact statement) and is rendered
// through TranslatableDynamic. A HEADLINE section's title is not data at all —
// it is app copy, already localized — so it is composed here from the section's
// kind + country code rather than being baked into the RN-free selector.

import { countryNameForAlpha2 } from '@/components/custom/locations/location-display';
import { sectionKindOf, type FactRow } from '@/lib/stores/fact-rows-selector';
import type { TFunction } from 'i18next';

/** The `t` from `useTranslation()`. Typed as i18next's own `TFunction` (the app
 *  declares its resources in lib/i18n/types.ts), so a typo in one of the keys
 *  below is a compile error rather than a raw key rendered on screen. */
export type Translate = TFunction<'translation'>;

/**
 * The display title for a Dashboard section.
 *
 * GLOBAL deliberately promises the COMPLEMENT ("Around the world"), never a
 * superlative. The server dedups a story to the FIRST scope that carries it and
 * country scopes are requested before GLOBAL, so a big domestic story appears in
 * the reader's country section and NOT in the global one. "Top global headlines"
 * would invite the reader to expect the world's biggest stories and then quietly
 * withhold the ones already shown above; "Around the world" promises only what
 * the section actually contains.
 *
 * COUNTRY titles name the country and promise NO count — 52 of 235 prod editions
 * cannot fill a top-20 and 9 are empty, so "Top 20 headlines from X" would be a
 * claim the data cannot keep. The country NAME (rather than a demonym) is used
 * because there is no demonym helper in the app and inventing one would break
 * for most of the 235 editions; the raw code is the last-resort fallback.
 */
export function sectionTitle(t: Translate, row: FactRow): string {
  switch (sectionKindOf(row)) {
    case 'headline-global':
      return t('forYou.headlineSectionGlobal');
    case 'headline-country': {
      const code = (row.countryCode ?? '').trim().toUpperCase();
      const country = countryNameForAlpha2(code) || code;
      return t('forYou.headlineSectionCountry', { country });
    }
    default:
      return row.statement;
  }
}
