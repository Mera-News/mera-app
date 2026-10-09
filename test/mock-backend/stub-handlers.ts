// Minimal handler set for the first emulator gate. Everything else falls to the
// host's unhandled paths on purpose, so a missing handler is loud.
import { graphql, http, HttpResponse } from 'msw';

export const handlers = [
    http.get('*/api/auth/get-session', () => HttpResponse.json(null)),
    graphql.query('AppVersionInfo', () =>
        HttpResponse.json({
            data: {
                appVersionInfo: { minSupportedVersion: '0.0.0', storeUrl: null },
            },
        }),
    ),
];
