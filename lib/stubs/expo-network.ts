// Stands in for expo-network, which the app's binary does not carry. better-auth's Expo client imports
// it optionally to follow connectivity, and Expo's native async require throws synchronously for a
// module missing from the bundle, so the import must resolve. With no listener the client keeps its
// own default, online, as it does when the import fails.
export function addNetworkStateListener(_listener: (state: { isInternetReachable?: boolean | null }) => void) {
    return { remove() {} };
}
