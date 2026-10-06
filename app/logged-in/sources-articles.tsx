import { Redirect, useLocalSearchParams } from 'expo-router';
import React from 'react';

// REDIRECT STUB. This route used to list ONE feed's articles; the app no
// longer shows feeds, so nothing links here. It stays so a restored navigation
// state or an old deep link still lands somewhere: the publication page for
// the publisher the link named. The feed id it used to carry is ignored.
export default function SourcesArticles() {
    const params = useLocalSearchParams<{ publisherName?: string; countryCode?: string }>();
    if (!params.publisherName) {
        return <Redirect href="/logged-in/app_container/feed" />;
    }
    return (
        <Redirect
            href={{
                pathname: '/logged-in/publication',
                params: { name: params.publisherName, ...(params.countryCode ? { country: params.countryCode } : {}) },
            }}
        />
    );
}
