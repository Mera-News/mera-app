import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * `t()` for keys built at runtime from the registry.
 *
 * `lib/i18n/types.ts` makes `en.json` the TypeScript source of truth for key
 * names, so i18next's `t` only accepts literal keys it can see in that file. Every
 * tutorial key is DERIVED (`tutorials.chapters.<slug>.slides.<id>.headline`), so
 * it is a `string` at the type level and no amount of typing makes it a literal
 * union.
 *
 * So the cast lives here, in one function, once — rather than as an `as any`
 * scattered across the player, the menu and four interaction components. Static
 * keys elsewhere in the module (`t('tutorials.skip')`) are written plainly and
 * stay fully checked.
 *
 * Lives under `components/` rather than `lib/` on purpose: it is a
 * React-Native-only shim with no logic to unit-test, and `lib/**` is under a
 * 92%-lines coverage gate that a bare `useTranslation()` wrapper would only
 * dilute.
 */
export type TutorialCopy = (
    key: string,
    options?: Record<string, unknown>,
) => string;

export function useTutorialCopy(): TutorialCopy {
    const { t } = useTranslation();

    return useCallback<TutorialCopy>(
        (key, options) =>
            (t as unknown as (k: string, o?: Record<string, unknown>) => string)(
                key,
                options,
            ),
        [t],
    );
}
