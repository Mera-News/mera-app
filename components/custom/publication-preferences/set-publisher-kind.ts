import type { PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';

/**
 * Set a publication's More / Fewer / Mute under EVERY name it is known by, so
 * it reaches every source the publication publishes as. Used by an adjusted
 * row and a search result on the Sources screen.
 *
 * A caller here has no Undo window, so a mute purges at once.
 */
export async function setPublisherKind(names: readonly string[], kind: PublicationPrefKind): Promise<void> {
    if (kind === 'mute') {
        const result = await setSourcePrefFromUi({ kind: 'publisher', names }, 'muted');
        await result.commitPurge?.();
        return;
    }
    await setSourcePrefFromUi({ kind: 'publisher', names }, kind === 'boost' ? 'prioritised' : 'deprioritised');
}
