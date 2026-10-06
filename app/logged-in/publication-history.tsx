// Old route: a publication's reading history is the History view of its
// publication page now. Kept so old links and restored screens open there.
// Both routes sit on the root stack, so a plain replace is safe here.
import { Redirect, useLocalSearchParams } from 'expo-router';
import React from 'react';

export default function PublicationHistory() {
    const params = useLocalSearchParams<{
        publicationName?: string;
        countryCode?: string;
    }>();

    if (!params.publicationName) {
        return <Redirect href="/logged-in/app_container/feed" />;
    }

    const target: Record<string, string> = { name: params.publicationName, order: 'HISTORY' };
    if (params.countryCode) target.country = params.countryCode;
    return <Redirect href={{ pathname: '/logged-in/publication', params: target }} />;
}
