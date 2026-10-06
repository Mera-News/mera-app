import { Redirect, useLocalSearchParams } from 'expo-router';
import React from 'react';

// REDIRECT STUB. This route used to be a publisher's "Top headlines" list,
// which is now the Top headlines tab of the publication page. It stays so a
// restored navigation state or an old deep link still lands somewhere.
export default function PublisherArticles() {
    const params = useLocalSearchParams<{ publisherId?: string; publisherName?: string }>();
    if (!params.publisherId) {
        return <Redirect href="/logged-in/app_container/feed" />;
    }
    return (
        <Redirect
            href={{
                pathname: '/logged-in/publication',
                params: {
                    publisherId: params.publisherId,
                    ...(params.publisherName ? { name: params.publisherName } : {}),
                    order: 'TOP_HEADLINES',
                },
            }}
        />
    );
}
