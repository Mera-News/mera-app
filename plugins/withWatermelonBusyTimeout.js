// Set SQLite's busy_timeout BEFORE journal_mode = WAL when WatermelonDB opens.
//
// The JSI adapter opens SQLite synchronously at module load, and the shared
// native open in @nozbe/watermelondb/native/shared/Database.cpp runs
// `pragma journal_mode = WAL;` before `pragma busy_timeout = 5000;`. When the
// previous JS runtime still holds the file (an OTA or language restart), the
// WAL pragma hits the lock with no busy handler and throws "database is
// locked", a fatal crash at launch (MERA-APP-8P). Swapping the two lines makes
// the open wait up to 5s instead. Upstream has no fix and no release since 0.28.
//
// The file is shared C++: the iOS pod and the Android JSI CMake build both
// compile it from node_modules, after prebuild, so one edit covers both
// platforms. It does not depend on the Expo template, so the same plugin works
// on any SDK. Idempotent, and it throws if the anchor moved, the same contract
// as withWatermelonJsi.js: a silently skipped edit ships the crash.

const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const WAL = '    initSql += "pragma journal_mode = WAL;";\n';
const TIMEOUT =
  '    // set timeout before SQLITE_BUSY error is returned\n' +
  '    initSql += "pragma busy_timeout = 5000;";\n';
const ORIGINAL = `${WAL}\n${TIMEOUT}`;
const PATCHED = `${TIMEOUT}\n${WAL}`;

/** Returns the patched source; throws when neither order is present. */
function patchDatabaseCpp(src) {
  if (src.includes(PATCHED)) return src;
  if (!src.includes(ORIGINAL)) {
    throw new Error(
      'withWatermelonBusyTimeout: the journal_mode/busy_timeout pragmas moved in WatermelonDB Database.cpp',
    );
  }
  return src.replace(ORIGINAL, PATCHED);
}

function databaseCppPath(projectRoot) {
  const pkg = require.resolve('@nozbe/watermelondb/package.json', { paths: [projectRoot] });
  return path.join(path.dirname(pkg), 'native', 'shared', 'Database.cpp');
}

function patchFile(cfg) {
  const file = databaseCppPath(cfg.modRequest.projectRoot);
  const src = fs.readFileSync(file, 'utf8');
  const next = patchDatabaseCpp(src);
  if (next !== src) fs.writeFileSync(file, next);
  return cfg;
}

function withWatermelonBusyTimeout(config) {
  config = withDangerousMod(config, ['ios', patchFile]);
  return withDangerousMod(config, ['android', patchFile]);
}

module.exports = withWatermelonBusyTimeout;
module.exports.patchDatabaseCpp = patchDatabaseCpp;
module.exports.databaseCppPath = databaseCppPath;
