#!/usr/bin/env bash
# Android e2e lane: build the e2e APK, start the mock backend, boot the AVD, run Maestro,
# enforce the network allowlist, clean up. One run at a time; never wrap this in bin/heavy
# (it takes all heavy slots itself). Flags: see usage below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$ROOT/scripts/e2e-android.sh"
cd "$ROOT"

PORT=8790
AVD=Mera_Harness_API35
SERIAL=emulator-5554
APP_ID=com.mera.news.e2e
SCHEME=meraapp-e2e
EMAIL=e2e-fixture@example.com
OTP=424242
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_HOME="$SDK"  # Gradle needs it; not in the user profile
EMU="$SDK/emulator/emulator"
ADB="$SDK/platform-tools/adb"
RUN="e2e-output/$(date +%Y%m%d-%H%M%S)"
APK_OUT=android/app/build/outputs/apk/release/app-release.apk
LAST=e2e-output/last-app-e2e.apk
ALLOWLIST=.maestro/proxy-allowlist.txt

ORIG_ARGS=("$@")
DRY=0 FLOWS=.maestro/ SKIP_BUILD=0 CLEAN=0 BASELINE="" PROXY_MODE=emulator
HANDLERS="${E2E_HANDLERS:-./stub-handlers}"

usage() {
  echo "usage: $0 [--dry-run] [--flows <path>] [--skip-build] [--clean] [--baseline <seconds>]" >&2
  echo "          [--handlers <module>] [--proxy-mode emulator|adb]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --flows) FLOWS="${2:?}"; shift ;;
    --skip-build) SKIP_BUILD=1 ;;
    --clean) CLEAN=1 ;;
    --baseline) BASELINE="${2:?}"; shift ;;
    --handlers) HANDLERS="${2:?}"; shift ;;
    --proxy-mode) PROXY_MODE="${2:?}"; shift ;;
    *) usage ;;
  esac
  shift
done
case "$PROXY_MODE" in emulator | adb) ;; *) usage ;; esac

# Hosts of `connect` lines and `via:"proxy"` lines in the proxy log, minus the allowlist.
# With no allowlist argument it only prints the host set (used by --baseline).
HOSTS_JS='
const fs = require("fs");
const [log, allow] = process.argv.slice(1);
const hosts = new Set();
for (const line of fs.readFileSync(log, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let l; try { l = JSON.parse(line); } catch { continue; }
  if (!(l.type === "connect" || l.kind === "connect" || l.event === "connect" || l.via === "proxy")) continue;
  let h = l.host || l.authority;
  if (!h && l.url) { try { h = new URL(l.url).host; } catch {} }
  if (h && l.port && !String(h).includes(":")) h = h + ":" + l.port;
  if (h) hosts.add(String(h));
}
if (!allow) { console.log([...hosts].sort().join("\n")); process.exit(0); }
const ok = new Set(fs.readFileSync(allow, "utf8").split("\n").map(s => s.replace(/#.*/, "").trim()).filter(Boolean));
const extra = [...hosts].filter(h => !ok.has(h) && !ok.has(h.replace(/:\d+$/, ""))).sort();
if (extra.length) { console.error("hosts outside the allowlist:\n" + extra.join("\n")); process.exit(1); }
console.log("allowlist ok (" + hosts.size + " hosts seen)");
'

if [ "$DRY" = 1 ]; then
  cat <<PLAN
e2e-android --dry-run (nothing is run, no heavy slot is taken)
ROOT=$ROOT  RUN=$RUN  mode=$( [ -n "$BASELINE" ] && echo "baseline ${BASELINE}s" || echo lane )  proxy=$PROXY_MODE  flows=$FLOWS  handlers=$HANDLERS
step 0 preflight: re-exec as E2E_HEAVY_HELD=1 $ROOT/../bin/heavy --all bash $SELF; abort if adb lists an emulator-*; require maestro, $EMU, $ADB; mkdir -p $RUN; trap cleanup EXIT INT TERM
step 1 prebuild$( [ "$SKIP_BUILD" = 1 ] && echo " (skipped: --skip-build)" )$( [ -n "$BASELINE" ] && echo " (skipped: --baseline)" ): (set -a; . ./.env.e2e; EXPO_NO_DOTENV=1 TMPDIR=$ROOT/e2e-output/.metro-tmp npx expo prebuild --platform android --no-install$( [ "$CLEAN" = 1 ] && echo " --clean" ))
step 2 gradle$( [ "$SKIP_BUILD" = 1 ] && echo " (skipped: --skip-build; bundle grep still runs)" )$( [ -n "$BASELINE" ] && echo " (skipped: --baseline)" ): (cd android && SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon); cp $APK_OUT $LAST; unzip -p $LAST assets/index.android.bundle | strings > $RUN/bundle-strings.txt; require 10.0.2.2:$PORT, forbid prod hosts / sentry DSN / RevenueCat keys / Intercom keys
step 3 mock server: npx tsx test/mock-backend/server.ts --port $PORT --log $RUN/proxy.jsonl --handlers $HANDLERS > $RUN/mock.log; poll http://127.0.0.1:$PORT/__control/health (30 s)
step 4 boot: $EMU @$AVD -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect$( [ "$PROXY_MODE" = emulator ] && echo " -http-proxy http://127.0.0.1:$PORT" ) > $RUN/emulator.log; wait-for-device; sys.boot_completed (300 s)$( [ "$PROXY_MODE" = adb ] && echo "; adb shell settings put global http_proxy 10.0.2.2:$PORT" ); screenshot $RUN/launcher.png
PLAN
  if [ -n "$BASELINE" ]; then
    echo "baseline: no install; record proxy hosts for ${BASELINE}s -> $RUN/baseline-hosts.txt; positive control: adb shell am start -a android.intent.action.VIEW -d https://example.com, wait 15 s, require example.com in $RUN/proxy.jsonl; print the host set; steps 5-7 skipped"
  else
    cat <<PLAN
step 5 install: adb -s $SERIAL install -r $LAST
step 6 maestro: MAESTRO_CLI_NO_ANALYTICS=1 maestro --device $SERIAL test $FLOWS --test-output-dir $RUN/maestro --format junit --output $RUN/junit.xml -e MOCK=http://localhost:$PORT -e EMAIL=$EMAIL -e OTP=$OTP -e APP_ID=$APP_ID -e SCHEME=$SCHEME; logcat -d > $RUN/logcat.txt; report WMDatabaseJSIBridge install line and FATAL lines
step 7 allowlist: hosts of connect / via:proxy lines in $RUN/proxy.jsonl minus $ALLOWLIST; extras fail the run
PLAN
  fi
  cat <<PLAN
step 8 cleanup (always, idempotent): $( [ "$PROXY_MODE" = adb ] && echo "adb shell settings put global http_proxy :0; " )adb -s $SERIAL emu kill; wait up to 60 s for pgrep -f "@$AVD" to clear; kill mock server
exit code: maestro's if non-zero, else the allowlist's
PLAN
  exit 0
fi

# ---- step 0: preflight -------------------------------------------------------------------
HEAVY="$ROOT/../bin/heavy"
if [ -z "${E2E_HEAVY_HELD:-}" ]; then
  if [ -x "$HEAVY" ]; then
    E2E_HEAVY_HELD=1 exec "$HEAVY" --all bash "$SELF" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  fi
  echo "warn: $HEAVY missing; running without holding the heavy slots" >&2
fi
[ -x "$EMU" ] || { echo "error: emulator binary not found at $EMU" >&2; exit 1; }
[ -x "$ADB" ] || { echo "error: adb not found at $ADB" >&2; exit 1; }
command -v maestro > /dev/null || { echo "error: maestro not on PATH (brew install mobile-dev-inc/tap/maestro)" >&2; exit 1; }
if "$ADB" devices | grep -q '^emulator-'; then
  echo "error: an emulator is already running; it belongs to another lane. Not touching it." >&2
  exit 1
fi
mkdir -p "$RUN"

MOCK_PID="" EMU_STARTED=0 PROXY_SET=0 CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  set +e
  [ "$PROXY_SET" = 1 ] && "$ADB" -s "$SERIAL" shell settings put global http_proxy :0
  if [ "$EMU_STARTED" = 1 ]; then
    "$ADB" -s "$SERIAL" emu kill > /dev/null 2>&1
    for _ in $(seq 1 60); do pgrep -f "@$AVD" > /dev/null || break; sleep 1; done
    pgrep -f "@$AVD" > /dev/null && echo "warn: emulator @$AVD still running after 60 s" >&2
  fi
  if [ -n "$MOCK_PID" ]; then pkill -P "$MOCK_PID" 2> /dev/null; kill "$MOCK_PID" 2> /dev/null; fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

e2e_env() {
  set -a; . ./.env.e2e; set +a
  export EXPO_NO_DOTENV=1 TMPDIR="$ROOT/e2e-output/.metro-tmp"
  mkdir -p "$TMPDIR"
}

# ---- steps 1-2: build --------------------------------------------------------------------
if [ -z "$BASELINE" ]; then
  if [ "$SKIP_BUILD" = 0 ]; then
    echo "== step 1: prebuild"
    ( e2e_env; CI=1 npx expo prebuild --platform android --no-install $( [ "$CLEAN" = 1 ] && echo --clean ) )
    echo "== step 2: gradle"
    ( e2e_env; export SENTRY_DISABLE_AUTO_UPLOAD=true; cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon )
    cp "$APK_OUT" "$LAST"
  fi
  [ -f "$LAST" ] || { echo "error: $LAST missing; run without --skip-build" >&2; exit 1; }
  echo "== step 2: bundle grep"
  unzip -p "$LAST" assets/index.android.bundle | strings > "$RUN/bundle-strings.txt"
  grep -Fq "10.0.2.2:$PORT" "$RUN/bundle-strings.txt" || { echo "FAIL: bundle lacks 10.0.2.2:$PORT" >&2; exit 1; }
  BAD=0
  while IFS='|' read -r name pat; do
    if grep -Eq "$pat" "$RUN/bundle-strings.txt"; then echo "FAIL: bundle matches forbidden pattern: $name" >&2; BAD=1; fi
  done <<'PATTERNS'
prod-or-staging-host|(graphql|auth|inference)(\.staging)?\.mera\.news
sentry-dsn|https://[0-9a-f]{32}@[^ ]*sentry\.io
revenuecat-key|(appl|goog)_[A-Za-z0-9]{16,}
intercom-key|(android|ios)_sdk-[A-Za-z0-9-]{16,}
PATTERNS
  [ "$BAD" = 0 ] || exit 1
fi

# ---- step 3: mock server -----------------------------------------------------------------
echo "== step 3: mock server on :$PORT"
npx tsx test/mock-backend/server.ts --port "$PORT" --log "$RUN/proxy.jsonl" --handlers "$HANDLERS" > "$RUN/mock.log" 2>&1 &
MOCK_PID=$!
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/__control/health" > /dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "error: mock server not healthy after 30 s" >&2; tail -20 "$RUN/mock.log" >&2; exit 1; }
  sleep 1
done

# ---- step 4: boot ------------------------------------------------------------------------
echo "== step 4: boot $AVD"
EMU_ARGS=(-no-boot-anim -no-snapshot-save -gpu swiftshader_indirect)
[ "$PROXY_MODE" = emulator ] && EMU_ARGS+=(-http-proxy "http://127.0.0.1:$PORT")
EMU_STARTED=1
"$EMU" "@$AVD" "${EMU_ARGS[@]}" > "$RUN/emulator.log" 2>&1 &
"$ADB" -s "$SERIAL" wait-for-device
for i in $(seq 1 300); do
  [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = 1 ] && break
  [ "$i" = 300 ] && { echo "error: emulator not booted after 300 s" >&2; exit 1; }
  sleep 1
done
if [ "$PROXY_MODE" = adb ]; then
  PROXY_SET=1
  "$ADB" -s "$SERIAL" shell settings put global http_proxy "10.0.2.2:$PORT"
fi
"$ADB" -s "$SERIAL" emu screenrecord screenshot "$RUN/launcher.png" || echo "warn: launcher screenshot failed" >&2

# ---- baseline mode: OS traffic with no app installed -------------------------------------
if [ -n "$BASELINE" ]; then
  echo "== baseline: recording proxy hosts for ${BASELINE}s"
  sleep "$BASELINE"
  node -e "$HOSTS_JS" "$RUN/proxy.jsonl" > "$RUN/baseline-hosts.txt"
  "$ADB" -s "$SERIAL" shell am start -a android.intent.action.VIEW -d https://example.com > /dev/null
  sleep 15
  if ! grep -q 'example\.com' "$RUN/proxy.jsonl"; then
    echo "FAIL: positive control, example.com never reached the proxy log (the proxy sees nothing)" >&2
    exit 1
  fi
  echo "positive control ok. Baseline host set (paste into $ALLOWLIST):"
  cat "$RUN/baseline-hosts.txt"
  exit 0
fi

# ---- steps 5-6: install and Maestro ------------------------------------------------------
echo "== step 5: install"
"$ADB" -s "$SERIAL" install -r "$LAST"
echo "== step 6: maestro $FLOWS"
MAESTRO_RC=0
MAESTRO_CLI_NO_ANALYTICS=1 maestro --device "$SERIAL" test "$FLOWS" \
  --test-output-dir "$RUN/maestro" --format junit --output "$RUN/junit.xml" \
  -e MOCK="http://localhost:$PORT" -e EMAIL="$EMAIL" -e OTP="$OTP" -e APP_ID="$APP_ID" -e SCHEME="$SCHEME" || MAESTRO_RC=$?
"$ADB" -s "$SERIAL" logcat -d > "$RUN/logcat.txt" || true
grep -q 'WMDatabaseJSIBridge: Successfully installed' "$RUN/logcat.txt" && echo "logcat: WatermelonDB JSI installed" || echo "logcat: no WatermelonDB JSI install line"
grep -E 'ReactNativeJS.*FATAL|AndroidRuntime: FATAL' "$RUN/logcat.txt" || echo "logcat: no FATAL lines"

# ---- step 7: allowlist -------------------------------------------------------------------
echo "== step 7: allowlist"
ALLOW_RC=0
node -e "$HOSTS_JS" "$RUN/proxy.jsonl" "$ALLOWLIST" || ALLOW_RC=$?

# step 8 runs in the EXIT trap
echo "maestro exit $MAESTRO_RC, allowlist exit $ALLOW_RC, output in $RUN"
[ "$MAESTRO_RC" -ne 0 ] && exit "$MAESTRO_RC"
exit "$ALLOW_RC"
