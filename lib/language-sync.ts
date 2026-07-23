// One-way sync: the app's UI language (the picker) → the persona's
// `language_codes` in the DB.
//
// WHY: notifications and the async pipeline read `UserPersona.language_codes`,
// but the language the user actually picks in the app only ever lived in the
// local app-language store. The two drifted, so a push notification could
// arrive in a language the user never chose. This module makes the picker the
// source of truth for the PRIMARY language code, while PRESERVING any other
// codes the on-device chat LLM may have added (e.g. a second reading language).
//
// Direction is intentionally one-way (picker → DB). LLM-driven changes to
// `language_codes` do NOT flip the UI language.

import logger from './logger';

// NOTE: account-service and the user-store are require()d lazily inside the
// functions below (not statically imported). Importing this module must stay
// side-effect-free — the user-store transitively loads the WatermelonDB native
// module, and eager-loading that from every importer (OnboardingWizard,
// hydrate-stores) breaks their unit-test environments. Lazy require also guards
// against a static store↔sync import cycle.

/**
 * Merge `lang` into `existing` as the primary (index 0), de-duplicated and
 * order-preserving for the rest. Pure — exported for testing.
 */
export function mergePrimaryLanguage(
  lang: string,
  existing: string[],
): string[] {
  return [lang, ...existing.filter((c) => c !== lang)];
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Push the app UI language into the persona's `language_codes` as the primary
 * code, preserving the rest. No-ops when there is no logged-in user (early
 * onboarding — reconciliation covers it later) or when the array is already
 * correct.
 *
 * Never throws: a failed server sync is logged and swallowed so it can't block
 * the local UI language change. Safe to call fire-and-forget.
 *
 * @param normalizedLang already-normalized app language code (e.g. 'zh-Hans')
 * @param opts.userId    explicit user id (onboarding passes it before the
 *                       user-store settles); falls back to the store
 */
export async function syncAppLanguageToPersona(
  normalizedLang: string,
  opts?: { userId?: string },
): Promise<void> {
  try {
    // Lazy requires — see the note at the top of this file.
    const { useUserStore } = require('./stores/user-store');
    const { AccountService } = require('./account-service');

    const store = useUserStore.getState();
    const userId = opts?.userId ?? store.userId;
    if (!userId) return; // deferred to onboarding-completion / boot reconciliation

    // Merge against the freshest persona we can get. If the store's persona
    // belongs to this user, use it; otherwise fetch so we don't clobber codes
    // the LLM set server-side that we simply haven't loaded locally yet.
    let persona = store.userId === userId ? store.userPersona : null;
    if (!persona) {
      persona = await store.fetchUserPersona(userId);
    }

    const existing: string[] = persona?.language_codes ?? [];
    const next = mergePrimaryLanguage(normalizedLang, existing);
    if (sameOrder(existing, next)) return; // already primary, unchanged

    await AccountService.updateUserConfig(userId, { language_codes: next });

    // Reflect locally so the persona cache + the boot-reconciliation guard
    // agree without waiting for the next server fetch. The mutation only
    // returns a partial persona, so we merge into the current cached one.
    const cur = useUserStore.getState().userPersona;
    if (cur) {
      useUserStore.getState().setUserPersona({ ...cur, language_codes: next });
    }
  } catch (err) {
    logger.warn('[language-sync] failed to sync app language to persona', {
      error: String(err),
    });
  }
}

/**
 * Reconcile the persona's primary language with the current app UI language,
 * syncing only when they differ. Used at onboarding completion and on app boot
 * to backfill users who picked a language before this sync existed (or before
 * they were authenticated).
 *
 * Never throws.
 */
export async function reconcileAppLanguageWithPersona(opts?: {
  userId?: string;
}): Promise<void> {
  try {
    // Lazy requires — see the note at the top of this file.
    const { useAppLanguageStore } = require('./stores/app-language-store');
    const { useUserStore } = require('./stores/user-store');
    const appLanguage: string = useAppLanguageStore.getState().appLanguage;

    const store = useUserStore.getState();
    const userId = opts?.userId ?? store.userId;
    if (!userId) return;

    const primary =
      (store.userId === userId
        ? store.userPersona?.language_codes?.[0]
        : null) ?? null;
    if (primary === appLanguage) return; // already in sync

    await syncAppLanguageToPersona(appLanguage, { userId });
  } catch (err) {
    logger.warn('[language-sync] reconcile failed', { error: String(err) });
  }
}
