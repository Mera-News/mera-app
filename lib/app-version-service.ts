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
        });

        return data?.appVersionInfo ?? null;
    }
}

export default AppVersionService;
