const { withProjectBuildGradle } = require('@expo/config-plugins');

const SNIPPET = `
  configurations.all {
    resolutionStrategy.eachDependency { details ->
      if (details.requested.group == 'com.google.mlkit') {
        if (details.requested.name == 'translate')   { details.useVersion '17.0.3' }
        if (details.requested.name == 'language-id') { details.useVersion '17.0.6' }
      }
    }
  }
`;

module.exports = function withMlKit16kb(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withMlKit16kb only supports Groovy build.gradle');
    }
    if (cfg.modResults.contents.includes("'com.google.mlkit'")) {
      return cfg;
    }
    const replaced = cfg.modResults.contents.replace(
      /allprojects\s*\{([\s\S]*?)\n\}/,
      (_match, body) => `allprojects {${body}\n${SNIPPET}}`
    );
    if (replaced === cfg.modResults.contents) {
      throw new Error('withMlKit16kb: could not find allprojects { ... } block in build.gradle');
    }
    cfg.modResults.contents = replaced;
    return cfg;
  });
};
