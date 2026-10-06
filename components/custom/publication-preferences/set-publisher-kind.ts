import { applyPersonaAction } from '@/lib/database/services/persona-action-executor';
import type { PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';

/**
 * Set a publication's More / Fewer / Mute under EVERY name it is known by, so
 * it reaches every source the publication publishes as. Used by an adjusted
 * row and a search result on the Sources screen.
 *
 * More and Fewer go through the shared writer every other control uses
 * (`setSourcePrefFromUi`). Mute is not part of that vocabulary (a downrank is
 * not a block), so it stays a direct executor call per name.
 */
export async function setPublisherKind(names: readonly string[], kind: PublicationPrefKind): Promise<void> {
    if (kind === 'mute') {
        for (const name of names) {
            await applyPersonaAction(
                { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: name, publicationPref: 'mute' },
                'user',
            );
        }
        return;
    }
    await setSourcePrefFromUi({ kind: 'publisher', names }, kind === 'boost' ? 'prioritised' : 'deprioritised');
}
