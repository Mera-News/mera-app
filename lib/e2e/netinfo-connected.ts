// @react-native-community/netinfo for the phone lane only: metro.config.js resolves the package here
// when E2E_DEVICE_BUILD=1 (scripts/e2e-android.sh --device). That lane runs in airplane mode with the
// mock behind adb reverse, so real NetInfo reports offline and the scheduler's network tasks never
// run. The ssid doubles as the bundle marker the script greps.
const state = {
    type: 'wifi',
    isConnected: true,
    isInternetReachable: true,
    details: { ssid: 'e2e-netinfo-connected' },
};

type Listener = (s: typeof state) => void;

const addEventListener = (listener: Listener): (() => void) => {
    listener(state);
    return () => {};
};
const fetch = async (): Promise<typeof state> => state;
const refresh = fetch;
const configure = (): void => {};

export { addEventListener, configure, fetch, refresh };
export default { addEventListener, configure, fetch, refresh };
