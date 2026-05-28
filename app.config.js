const { execSync } = require('child_process');

let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
} catch {
  gitCommit = process.env.EAS_BUILD_GIT_COMMIT_HASH?.slice(0, 7) || 'unknown';
}

// Org / app identity is read from env at build time, falling back to the
// committed app.json values so a fresh checkout still has a valid shape. A
// forker either runs `eas init` + edits app.json directly, or sets these env
// vars (see .env.example "EAS / build" section). After changing native
// identity (bundle/package/name/scheme), run `npx expo prebuild --clean` to
// regenerate /ios and /android from this config.
module.exports = ({ config }) => {
  const owner = process.env.EXPO_OWNER || config.owner;
  const projectId =
    process.env.EAS_PROJECT_ID || config.extra?.eas?.projectId;
  const updatesUrl = projectId
    ? `https://u.expo.dev/${projectId}`
    : config.updates?.url;

  const name = process.env.APP_NAME || config.name;
  const slug = process.env.APP_SLUG || config.slug;
  const scheme = process.env.APP_SCHEME || config.scheme;

  const bundleIdentifier =
    process.env.APP_BUNDLE_ID || config.ios?.bundleIdentifier;
  const androidPackage = process.env.APP_PACKAGE || config.android?.package;
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_FILE || config.android?.googleServicesFile;

  const sentryOrg = process.env.SENTRY_ORG || 'mera-app';
  const sentryProject = process.env.SENTRY_PROJECT || 'mera-app';

  // Rewrite the @sentry/react-native/expo plugin tuple so org/project follow
  // env vars; everything else in the plugins array is left untouched.
  const plugins = (config.plugins || []).map((plugin) => {
    if (
      Array.isArray(plugin) &&
      plugin[0] === '@sentry/react-native/expo' &&
      plugin[1] &&
      typeof plugin[1] === 'object'
    ) {
      return [
        plugin[0],
        {
          ...plugin[1],
          organization: sentryOrg,
          project: sentryProject,
        },
      ];
    }
    return plugin;
  });

  return {
    ...config,
    name,
    slug,
    scheme,
    owner,
    plugins,
    updates: {
      ...config.updates,
      url: updatesUrl,
    },
    ios: {
      ...config.ios,
      bundleIdentifier,
    },
    android: {
      ...config.android,
      package: androidPackage,
      googleServicesFile,
    },
    extra: {
      ...config.extra,
      gitCommit,
      eas: {
        ...config.extra?.eas,
        projectId,
      },
    },
  };
};
