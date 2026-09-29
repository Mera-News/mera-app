// Wire WatermelonDB's Android JSI module, which autolinking never includes.
//
// `lib/database/index.ts` asks for `jsi: true`, but on Android the JSI half of
// @nozbe/watermelondb is a separate Gradle project (native/android-jsi). With
// CNG nothing included it, so every Android build logged "JSI SQLiteAdapter
// not available… falling back to asynchronous operation" and ran every query,
// write and hydrate over the async bridge. iOS gets JSI from the pod.
// See plans/ready_to_implement/native_build_plans/ANDROID_WATERMELONDB_JSI_PLAN.md.
//
// Three edits, each idempotent and each throwing if its anchor moved, the same
// contract as withMlKit16kb.js: a silently skipped edit would ship a binary
// that still falls back, which is the bug this exists to fix.

const { withAppBuildGradle, withMainApplication, withSettingsGradle } = require('@expo/config-plugins');

const PROJECT = ':watermelondb-jsi';
const SETTINGS_SNIPPET = `
include '${PROJECT}'
project('${PROJECT}').projectDir = new File(rootProject.projectDir, '../node_modules/@nozbe/watermelondb/native/android-jsi')
`;
const DEPENDENCY = `    implementation project('${PROJECT}')`;
const PACKAGE = 'add(com.nozbe.watermelondb.jsi.WatermelonDBJSIPackage())';

function withJsiSettings(config) {
  return withSettingsGradle(config, (cfg) => {
    const src = cfg.modResults.contents;
    if (src.includes(`include '${PROJECT}'`)) return cfg;
    if (!/include ':app'/.test(src)) {
      throw new Error("withWatermelonJsi: could not find include ':app' in settings.gradle");
    }
    cfg.modResults.contents = src.replace(/include ':app'\n/, (m) => `${m}${SETTINGS_SNIPPET}`);
    return cfg;
  });
}

function withJsiDependency(config) {
  return withAppBuildGradle(config, (cfg) => {
    const src = cfg.modResults.contents;
    if (src.includes(`project('${PROJECT}')`)) return cfg;
    if (!/\ndependencies \{\n/.test(src)) {
      throw new Error('withWatermelonJsi: could not find the dependencies { block in app/build.gradle');
    }
    cfg.modResults.contents = src.replace(/\ndependencies \{\n/, (m) => `${m}${DEPENDENCY}\n`);
    return cfg;
  });
}

function withJsiPackage(config) {
  return withMainApplication(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error('withWatermelonJsi only supports a Kotlin MainApplication');
    }
    const src = cfg.modResults.contents;
    if (src.includes(PACKAGE)) return cfg;
    const anchor = /PackageList\(this\)\.packages\.apply \{\n/;
    if (!anchor.test(src)) {
      throw new Error('withWatermelonJsi: could not find PackageList(this).packages.apply { in MainApplication.kt');
    }
    cfg.modResults.contents = src.replace(anchor, (m) => `${m}          ${PACKAGE}\n`);
    return cfg;
  });
}

module.exports = function withWatermelonJsi(config) {
  return withJsiPackage(withJsiDependency(withJsiSettings(config)));
};
