#!/usr/bin/env bash
# Android e2e lane: build the e2e APK, start the mock backend, boot the AVD, run Maestro,
# check the app's own sockets, clean up. One run at a time; never wrap this in bin/heavy
# (it takes all heavy slots itself). Flags: see usage below.
#
# Network rule (no test talks to a server): the mock doubles as the emulator's HTTP proxy and
# refuses every foreign host, so nothing outside reaches a server. That log cannot say WHO asked
# (the playstore image's OS traffic arrives as raw IPs), so step 7 samples the sockets owned by the
# app's uid from /proc/net and fails on any remote other than the mock. Denied proxy connections are
# held open for 3 s so the 0.2 s sampler sees them.
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

ORIG_ARGS=("$@")
DRY=0 SKIP_BUILD=0 CLEAN=0 ALLOW_DIRTY=0
FLOWS=()
HANDLERS="${E2E_HANDLERS:-./handlers}"

usage() {
  echo "usage: $0 [--dry-run] [--flows <path>]... [--skip-build] [--clean] [--handlers <module>]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --flows) FLOWS+=("${2:?}"); shift ;;  # repeatable: several flows or dirs, one boot
    --skip-build) SKIP_BUILD=1 ;;
    --clean) CLEAN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;  # build with uncommitted app source (the APK then matches no commit)
    --handlers) HANDLERS="${2:?}"; shift ;;
    *) usage ;;
  esac
  shift
done
[ "${#FLOWS[@]}" -gt 0 ] || FLOWS=(.maestro/)

# Remote endpoints of the app-uid sockets sampled from /proc/net/tcp{,6}. Allowed: the mock
# (10.0.2.2:PORT), loopback and unconnected sockets. Requires at least one socket to the mock,
# so a sampler that reads nothing cannot pass.
SOCK_JS='
const fs = require("fs");
const [file, port] = process.argv.slice(1);
const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const v4 = (h) => [0, 1, 2, 3].map((i) => parseInt(h.substr(6 - 2 * i, 2), 16)).join(".");
const decode = (hex) => {
  const [a, p] = hex.split(":");
  const prt = parseInt(p, 16);
  if (a.length === 8) return { ip: v4(a), port: prt };
  const w = [0, 1, 2, 3].map((i) => a.substr(8 * i, 8));
  if (w[0] === "00000000" && w[1] === "00000000" && w[2] === "FFFF0000") return { ip: v4(w[3]), port: prt };
  const ip6 = w.map((x) => x.match(/../g).reverse().join("")).join("").toLowerCase();
  return { ip: "[" + ip6.match(/.{4}/g).join(":") + "]", port: prt };
};
let mock = 0;
const foreign = new Set();
for (const r of rows) {
  const [addr, st] = r.trim().split(/\s+/);
  const { ip, port: p } = decode(addr);
  if (ip === "10.0.2.2" && p === Number(port)) { mock++; continue; }
  if (ip === "0.0.0.0" || ip === "127.0.0.1" || /^\[0000(:0000){6}:000[01]\]$/.test(ip)) continue;
  // st: /proc/net tcp state, 01 ESTABLISHED, 02 SYN_SENT, 06 TIME_WAIT (uid 0, never seen here).
  foreign.add(ip + ":" + p + (st ? " (state " + st + ")" : ""));
}
if (mock === 0) { console.error("FAIL: no app socket to the mock was sampled (sampler blind or app never reached the mock)"); process.exit(1); }
if (foreign.size) { console.error("FAIL: app sockets to non-mock hosts:\n" + [...foreign].sort().join("\n")); process.exit(1); }
console.log("app sockets ok (" + mock + " samples to the mock, none elsewhere)");
'

if [ "$DRY" = 1 ]; then
  cat <<PLAN
e2e-android --dry-run (nothing is run, no heavy slot is taken)
ROOT=$ROOT  RUN=$RUN  flows=${FLOWS[*]}  handlers=$HANDLERS
step 0 preflight: re-exec as E2E_HEAVY_HELD=1 $ROOT/../bin/heavy --all bash $SELF; abort if adb lists an emulator-*; require maestro, $EMU, $ADB; mkdir -p $RUN; trap cleanup EXIT INT TERM
step 1 prebuild$( [ "$SKIP_BUILD" = 1 ] && echo " (skipped: --skip-build)" ): (set -a; . ./.env.e2e; CI=1 EXPO_NO_DOTENV=1 TMPDIR=$ROOT/e2e-output/.metro-tmp npx expo prebuild --platform android --no-install$( [ "$CLEAN" = 1 ] && echo " --clean" ))
step 2 gradle$( [ "$SKIP_BUILD" = 1 ] && echo " (skipped: --skip-build; bundle grep still runs)" ): (cd android && SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2 -Pkotlin.compiler.execution.strategy=in-process); cp $APK_OUT $LAST; grep the raw bundle: require 10.0.2.2:$PORT, forbid prod/staging endpoint hosts and every .env secret value (DSN, KEY, TOKEN, APP_ID, CLIENT_ID)
step 3 mock server: npx tsx test/mock-backend/server.ts --port $PORT --log $RUN/proxy.jsonl --deny-delay 3000 --handlers $HANDLERS > $RUN/mock.log; poll http://127.0.0.1:$PORT/__control/health (30 s)
step 4 boot: $EMU @$AVD -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect -memory 3072 -http-proxy http://127.0.0.1:$PORT > $RUN/emulator.log; wait-for-device; sys.boot_completed (300 s); screenshot $RUN/launcher.png
step 5 install: adb -s $SERIAL install -r $LAST; resolve the app uid; require /proc/net/tcp6 readable; start the 0.2 s on-device app-socket sampler -> $RUN/app-sockets.txt
step 6 maestro: MAESTRO_CLI_NO_ANALYTICS=1 maestro --device $SERIAL test ${FLOWS[*]} --test-output-dir $RUN/maestro --format junit --output $RUN/junit.xml -e MOCK=http://localhost:$PORT -e EMAIL=$EMAIL -e OTP=$OTP -e APP_ID=$APP_ID -e SCHEME=$SCHEME; stop the sampler; logcat -d > $RUN/logcat.txt; report WMDatabaseJSIBridge install line and FATAL lines
step 7 app sockets: every sampled app-uid remote must be 10.0.2.2:$PORT (or loopback/unconnected), and at least one must be the mock
step 8 cleanup (always, idempotent): stop sampler; adb -s $SERIAL emu kill; wait up to 60 s for pgrep -f "@$AVD" to clear; kill mock server
exit code: maestro's if non-zero, else step 7's
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

MOCK_PID="" EMU_STARTED=0 SAMPLER_PID="" CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  set +e
  [ -n "$SAMPLER_PID" ] && { pkill -P "$SAMPLER_PID" 2> /dev/null; kill "$SAMPLER_PID" 2> /dev/null; }
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

# The APK must match a commit: refuse to build over uncommitted app source (R29). Checked right
# before prebuild and again right before Gradle.
require_clean() {
  [ "$ALLOW_DIRTY" = 1 ] && return 0
  local dirty
  # Test files never reach the bundle, so their churn (a gate runner's deletions) does not count.
  dirty="$(git status --porcelain -- app components lib modules plugins app.json app.config.js package.json \
    | grep -vE '(__tests__/|\.(test|spec)\.[jt]sx?$)' || true)"
  if [ -n "$dirty" ]; then
    echo "FAIL: uncommitted app source; the APK would match no commit (--allow-dirty to override):" >&2
    echo "$dirty" >&2
    exit 1
  fi
}

e2e_env() {
  set -a; . ./.env.e2e; set +a
  export EXPO_NO_DOTENV=1 TMPDIR="$ROOT/e2e-output/.metro-tmp"
  mkdir -p "$TMPDIR"
}

# ---- steps 1-2: build --------------------------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  require_clean
  BUILT_SHA="$(git rev-parse --short HEAD)"
  echo "== step 1: prebuild (HEAD $BUILT_SHA)"
  ( e2e_env; CI=1 npx expo prebuild --platform android --no-install $( [ "$CLEAN" = 1 ] && echo --clean ) )
  require_clean
  [ "$(git rev-parse --short HEAD)" = "$BUILT_SHA" ] || { echo "FAIL: HEAD moved during prebuild" >&2; exit 1; }
  echo "== step 2: gradle"
  ( e2e_env; export SENTRY_DISABLE_AUTO_UPLOAD=true; cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2 -Pkotlin.compiler.execution.strategy=in-process )
  cp "$APK_OUT" "$LAST"
  echo "$BUILT_SHA" > "$LAST.sha"
fi
[ -f "$LAST" ] || { echo "error: $LAST missing; run without --skip-build" >&2; exit 1; }
echo "== step 2: bundle grep"
# Grep the raw Hermes bytecode: macOS `strings` skips non-Mach-O content, and
# Hermes packs its strings back to back, so loose regexes match across
# neighbours. Hence one exact host pattern plus the developer's own secret
# values, matched as fixed strings (names only are printed, never values).
BUNDLE="$RUN/index.android.bundle"
unzip -p "$LAST" assets/index.android.bundle > "$BUNDLE"
LC_ALL=C grep -a -q -F "10.0.2.2:$PORT" "$BUNDLE" || { echo "FAIL: bundle lacks 10.0.2.2:$PORT" >&2; exit 1; }
# metro.config.js swaps in the scenario-driven paywall stub (lib/e2e/purchases-ui.ts) for this build.
LC_ALL=C grep -a -q -F "/__e2e/paywall" "$BUNDLE" || { echo "FAIL: bundle lacks the e2e paywall stub" >&2; exit 1; }
BAD=0
if LC_ALL=C grep -a -q -E '(graphql|auth|inference)(\.staging)?\.mera\.news' "$BUNDLE"; then
  echo "FAIL: bundle contains a prod or staging endpoint host" >&2; BAD=1
fi
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in EXPO_PUBLIC_*DSN|EXPO_PUBLIC_*KEY|EXPO_PUBLIC_*TOKEN|EXPO_PUBLIC_*APP_ID|EXPO_PUBLIC_*CLIENT_ID) ;; *) continue ;; esac
    v="${v%\"}"; v="${v#\"}"
    [ "${#v}" -ge 8 ] || continue
    if LC_ALL=C grep -a -q -F -- "$v" "$BUNDLE"; then echo "FAIL: bundle contains the .env value of $k" >&2; BAD=1; fi
  done < .env
else
  echo "warn: no .env to check secrets against" >&2
fi
rm -f "$BUNDLE"
[ "$BAD" = 0 ] || exit 1

# ---- step 3: mock server -----------------------------------------------------------------
echo "== step 3: mock server on :$PORT"
npx tsx test/mock-backend/server.ts --port "$PORT" --log "$RUN/proxy.jsonl" --deny-delay 3000 --handlers "$HANDLERS" > "$RUN/mock.log" 2>&1 &
MOCK_PID=$!
for i in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/__control/health" > /dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "error: mock server not healthy after 30 s" >&2; tail -20 "$RUN/mock.log" >&2; exit 1; }
  sleep 1
done

# ---- step 4: boot ------------------------------------------------------------------------
echo "== step 4: boot $AVD"
EMU_STARTED=1
"$EMU" "@$AVD" -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect -memory 3072 \
  -http-proxy "http://127.0.0.1:$PORT" > "$RUN/emulator.log" 2>&1 &
"$ADB" -s "$SERIAL" wait-for-device
for i in $(seq 1 300); do
  [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = 1 ] && break
  [ "$i" = 300 ] && { echo "error: emulator not booted after 300 s" >&2; exit 1; }
  sleep 1
done
"$ADB" -s "$SERIAL" emu screenrecord screenshot "$RUN/launcher.png" || echo "warn: launcher screenshot failed" >&2

# ---- step 5: install and the app-socket sampler ------------------------------------------
echo "== step 5: install"
"$ADB" -s "$SERIAL" install -r "$LAST"
APP_UID="$("$ADB" -s "$SERIAL" shell pm list packages -U "$APP_ID" | tr -d '\r' | sed -n 's/.*uid://p' | head -1)"
[ -n "$APP_UID" ] || { echo "error: could not resolve the uid of $APP_ID" >&2; exit 1; }
"$ADB" -s "$SERIAL" shell cat /proc/net/tcp6 | head -1 | grep -q local_address \
  || { echo "error: /proc/net/tcp6 is not readable over adb; the socket check would be blind" >&2; exit 1; }
: > "$RUN/app-sockets.txt"
# One on-device loop at 0.2 s (an adb round trip per sample would be ~1 s). TIME_WAIT rows carry
# uid 0, so a connection opened and closed inside one interval can still slip by; the proxy holds
# every refused foreign connection 3 s, and D3's negative control measures the direct path.
(
  "$ADB" -s "$SERIAL" shell "while :; do cat /proc/net/tcp /proc/net/tcp6; sleep 0.2; done" 2> /dev/null \
    | tr -d '\r' | awk -v u="$APP_UID" '$8 == u { print $3, $4; fflush() }' >> "$RUN/app-sockets.txt"
) &
SAMPLER_PID=$!

# ---- step 6: Maestro ---------------------------------------------------------------------
echo "== step 6: maestro ${FLOWS[*]}"
MAESTRO_RC=0
MAESTRO_CLI_NO_ANALYTICS=1 maestro --device "$SERIAL" test "${FLOWS[@]}" \
  --test-output-dir "$RUN/maestro" --format junit --output "$RUN/junit.xml" \
  -e MOCK="http://localhost:$PORT" -e EMAIL="$EMAIL" -e OTP="$OTP" -e APP_ID="$APP_ID" -e SCHEME="$SCHEME" \
  -e IMAGE_ORIGIN="${IMAGE_ORIGIN:-}" || MAESTRO_RC=$?
pkill -P "$SAMPLER_PID" 2> /dev/null || true; kill "$SAMPLER_PID" 2> /dev/null || true
SAMPLER_PID=""
"$ADB" -s "$SERIAL" logcat -d > "$RUN/logcat.txt" || true
grep -q 'WMDatabaseJSIBridge: Successfully installed' "$RUN/logcat.txt" && echo "logcat: WatermelonDB JSI installed" || echo "logcat: no WatermelonDB JSI install line"
grep -E 'ReactNativeJS.*FATAL|AndroidRuntime: FATAL' "$RUN/logcat.txt" || echo "logcat: no FATAL lines"

# ---- step 7: app sockets -----------------------------------------------------------------
echo "== step 7: app sockets"
SOCK_RC=0
node -e "$SOCK_JS" "$RUN/app-sockets.txt" "$PORT" || SOCK_RC=$?
echo "proxy (diagnostic): $(grep -c '"status":403' "$RUN/proxy.jsonl" || true) foreign connections refused"

# Flows tagged `blocked` are skipped by .maestro/config.yaml; name them on every run so the
# exclusion can never go silent.
BLOCKED="$(grep -l -E '^[[:space:]]*-[[:space:]]*blocked[[:space:]]*$' .maestro/*.yaml 2> /dev/null | grep -v config.yaml | xargs -n1 basename 2> /dev/null | tr '\n' ' ' || true)"
[ -n "$BLOCKED" ] && echo "EXCLUDED (tag blocked, see each flow's header): $BLOCKED"

# step 8 runs in the EXIT trap
echo "apk built from $(cat "$LAST.sha" 2> /dev/null || echo unknown)"
echo "maestro exit $MAESTRO_RC, app-socket exit $SOCK_RC, output in $RUN"
[ "$MAESTRO_RC" -ne 0 ] && exit "$MAESTRO_RC"
exit "$SOCK_RC"
