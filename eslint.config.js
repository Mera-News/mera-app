// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

/**
 * Files allowed to import GluestackUIProvider.
 *
 * The root is the only place that should ever mount it. Everything else
 * inherits the scheme through React's VariableContext. A bare provider used to
 * default `mode` to 'light' and silently flip the whole app; `mode` is now
 * required, and this rule stops a second one being mounted at all.
 *
 * The `components/custom/**` entries are P1b: their provider sits inside an RN
 * `<Modal>`, a separate native window, and the claim that variables still
 * propagate across that boundary cannot be tested in jest. They stay wrapped
 * until it is checked on a device, and this list shrinks to zero when that
 * happens. It may never grow.
 *
 * Enforced again at runtime by
 * components/ui/gluestack-ui-provider/__tests__/single-provider.test.ts, because
 * lint here is run per-changed-file and a new provider in an unlinted file would
 * otherwise sail through.
 */
const PROVIDER_ALLOWLIST = [
  'app/_layout.tsx',
  'components/custom/VideoPlayerModal.tsx',
  'components/custom/auth/LanguageSelector.tsx',
  'components/custom/auth/LegalFooter.tsx',
  'components/custom/config-mera/LanguageSettingsScreen.tsx',
  'components/custom/subscription/EmailCaptureSheet.tsx',
  'components/custom/tutorials/TutorialModalHost.tsx',
];

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    files: ['app/**/*.tsx', 'components/**/*.tsx'],
    ignores: [
      ...PROVIDER_ALLOWLIST,
      'components/ui/gluestack-ui-provider/**',
      '**/__tests__/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/components/ui/gluestack-ui-provider',
              importNames: ['GluestackUIProvider'],
              message:
                'Only app/_layout.tsx mounts GluestackUIProvider. Screens inherit the theme; read colours with useThemeColors() from @/lib/theme.',
            },
          ],
        },
      ],
    },
  },
]);
