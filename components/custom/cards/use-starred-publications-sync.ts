import { useStarredPublicationsStore } from '@/components/custom/cards/starred-publications';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { useEffect } from 'react';

/** Keeps the star set equal to `preferredPublications` (More from + Subscribed).
 *  The context hook re-reads on every tag or subscription change. */
export function useStarredPublicationsSync(): void {
    const ctx = useUserGeoLanguageContext();
    useEffect(() => {
        useStarredPublicationsStore.setState({ names: ctx?.preferredPublications ?? new Set() });
    }, [ctx]);
}
