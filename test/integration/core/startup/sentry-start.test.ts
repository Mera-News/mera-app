// Sentry starts at bundle evaluation on a foreground start, as before, and on a background or unknown
// start only once the app first comes to the foreground, in the same process.

const mockInit = jest.fn();
jest.mock('@sentry/react-native', () => ({
    init: (...a: unknown[]) => mockInit(...a),
    setContext: jest.fn(),
    setTag: jest.fn(),
    feedbackIntegration: jest.fn(() => ({ name: 'FeedbackIntegration' })),
    breadcrumbsIntegration: jest.fn(() => ({ name: 'Breadcrumbs' })),
    captureException: jest.fn(),
}));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.2.3', nativeBuildVersion: '456' }));
jest.mock('expo-updates', () => ({ updateId: 'u', channel: 'production', runtimeVersion: '1.2.3', isEmbeddedLaunch: false }));

const ENV_AT_LOAD = { ...process.env };

/** Loads sentry-init the way a launch does: a fresh module graph, with the given AppState read first.
 *  Returns that graph's AppState driver (a fresh registry has its own AppState). */
function launchIn(state: string): (next: 'active' | 'background') => void {
    jest.resetModules();
    const appState = require('@/test/helpers/app-state') as typeof import('@/test/helpers/app-state');
    appState.appStateModule.currentState = state as never;
    require('@/lib/app-host');
    require('@/lib/startup/foreground-gate').resetForegroundGateForTests();
    require('@/lib/sentry-init');
    return appState.setAppState;
}

beforeEach(() => {
    mockInit.mockClear();
    (global as any).__DEV__ = false;
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
});
afterEach(() => {
    (global as any).__DEV__ = true;
    for (const key of Object.keys(process.env)) if (!(key in ENV_AT_LOAD)) delete process.env[key];
    Object.assign(process.env, ENV_AT_LOAD);
});

it.each(['active', 'inactive'])('starts at bundle evaluation on a start read as %s, as today', (state) => {
    launchIn(state);
    expect(mockInit).toHaveBeenCalledTimes(1);
});

it.each(['background', 'unknown'])('is not started on a start read as %s, and starts once at the first active', (state) => {
    const setAppState = launchIn(state);
    expect(mockInit).not.toHaveBeenCalled();
    setAppState('active');
    setAppState('background');
    setAppState('active');
    expect(mockInit).toHaveBeenCalledTimes(1);
});

it('is never started when a background start never comes to the foreground', () => {
    const setAppState = launchIn('background');
    setAppState('background');
    expect(mockInit).not.toHaveBeenCalled();
});
