import { gql } from '@apollo/client';
import { Platform } from 'react-native';
import client from './apollo-client';
import { AppPlatform } from './generated/graphql-types';

const APP_VERSION_INFO = gql`
  query AppVersionInfo($platform: AppPlatform!) {
    appVersionInfo(platform: $platform) {
      minSupportedVersion
      storeUrl
    }
  }
`;

export interface AppVersionInfo {
    minSupportedVersion: string | null;
    storeUrl: string | null;
}

interface AppVersionInfoResponse {
    appVersionInfo: AppVersionInfo;
}

export class AppVersionService {
    /**
     * Fetch the store's latest / minimum-supported native version for the current
     * platform. Thin by design — callers handle (and suppress) transient network
     * errors, since this runs best-effort at startup. This query is whitelisted as
     * public on the server, so it works without a session.
     */
    static async getVersionInfo(): Promise<AppVersionInfo | null> {
        const platform =
            Platform.OS === 'ios' ? AppPlatform.Ios : AppPlatform.Android;

        const { data } = await client.query<AppVersionInfoResponse>({
            query: APP_VERSION_INFO,
            variables: { platform },
            fetchPolicy: 'no-cache',
            // Opt out of the feed-wide "sync failed" banner. The error link
            // paints it for any GraphQL error on any operation that has not
            // opted out, and this one has nothing to do with the feed: it is a
            // best-effort startup check on a query the server whitelists as
            // public. Without this, a throttled or briefly failing version
            // check tells the user their news is broken - and a 429 storm is
            // exactly when this and the feed sync fail together.
            //
            // Suppresses the BANNER only; the Sentry capture is unchanged.
            // Same rationale as intercomIdentity, the other opted-out call.
            context: { noSyncStatus: true },
        });

        return data?.appVersionInfo ?? null;
    }
}

export default AppVersionService;
