import {
    fetchPublicationPrefNames,
    resolvePublicationPrefNames,
} from '@/lib/database/services/publisher-source-names';
import { isLatched } from './news-latch';
import { ownNewsOn, ownNewsState } from './own-news-state';

const NAMES_OPERATION = 'PublicationSourcesForNewsPublisher';
const NAMES_FIELD = 'publicationSourcesForNewsPublisher';

type Hints = Parameters<typeof fetchPublicationPrefNames>[0];

/**
 * The names to write a publication preference under. A server that cannot list a publication's names
 * gets the names this phone already knows: a narrower write beats a control that always fails.
 */
export async function publicationPrefNamesForWrite(hints: Hints): Promise<string[]> {
    try {
        return await fetchPublicationPrefNames(hints);
    } catch (error) {
        const fields = ownNewsState.get()?.fields ?? null;
        const cannotList = isLatched(NAMES_OPERATION) || (fields !== null && !fields.includes(NAMES_FIELD));
        if (!ownNewsOn() || !cannotList) throw error;
        return resolvePublicationPrefNames(hints);
    }
}
