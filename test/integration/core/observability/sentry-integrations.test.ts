// The integrations Sentry actually sets up are its defaults merged with ours,
// and a Sentry upgrade can add a default without anyone touching sentry-init
// (8.x added TurboModuleContext and ExpoUpdatesListener). This resolves the
// real merge for the options sentry-init passes and pins the whole list, so a
// new default fails here until someone decides whether it is telemetry.

const mockSentryInit = jest.fn();

jest.mock('@sentry/react-native', () => ({
  init: mockSentryInit,
  setContext: jest.fn(),
  setTag: jest.fn(),
  feedbackIntegration: jest.fn(() => ({ name: 'Feedback' })),
  breadcrumbsIntegration: jest.fn(() => ({ name: 'Breadcrumbs' })),
  captureException: jest.fn(),
}));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.3.6', nativeBuildVersion: '1' }));
jest.mock('expo-updates', () => ({
  updateId: 'update-abc',
  channel: 'production',
  runtimeVersion: '1.3.6',
  isEmbeddedLaunch: false,
}));

// Every integration a production device runs, in setup order. Inert stand-ins
// keep the names of the defaults they switch off.
const ALLOWED = [
  'ReactNativeErrorHandlers',
  'NativeLinkedErrors',
  'InboundFilters',
  'FunctionToString',
  'Breadcrumbs',
  'Dedupe',
  'HttpContext',
  'Release',
  'EventOrigin',
  'SdkInfo',
  'ReactNativeInfo',
  'RewriteFrames',
  'DebugMeta',
  'DeviceContext',
  'ModulesLoader',
  'ExpoContext',
  'ExpoConstants',
  'ExpoUpdatesListener',
  'PrimitiveTagIntegration',
  'TurboModuleContext',
  'AnonymisePrefilledFeedback',
  'Feedback',
];

function resolvedIntegrations() {
  (global as any).__DEV__ = false;
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://test@sentry.io/123';
  jest.isolateModules(() => {
    require('@/lib/sentry-init');
  });
  const [config] = mockSentryInit.mock.calls[0];
  const { getDefaultIntegrations } = jest.requireActual('@sentry/react-native/dist/js/integrations/default');
  const { getIntegrationsToSetup } = jest.requireActual('@sentry/core');
  // A release device: native SDK on, init's own defaults under the app's options.
  const defaults = getDefaultIntegrations({ enableNative: true, enableCaptureFailedRequests: false, ...config });
  return getIntegrationsToSetup({ defaultIntegrations: defaults, integrations: config.integrations }) as Array<{
    name: string;
    setupOnce?: unknown;
    setup?: unknown;
    processEvent?: unknown;
  }>;
}

describe('Sentry integrations on a release build', () => {
  afterEach(() => {
    (global as any).__DEV__ = true;
    mockSentryInit.mockClear();
  });

  it('are exactly the allowlist', () => {
    expect(resolvedIntegrations().map((i) => i.name)).toEqual(ALLOWED);
  });

  it('run nothing for the two Sentry 8 telemetry defaults', () => {
    for (const name of ['TurboModuleContext', 'ExpoUpdatesListener']) {
      const integration = resolvedIntegrations().find((i) => i.name === name)!;
      expect(integration).toEqual({ name });
    }
  });
});
