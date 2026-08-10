# Android emulator harness

Companion to [README.md](README.md) (iOS). Same driver — `agent-device` — same loop, same
[testID conventions](README.md). This file records **only what was actually observed on Android**
on 2026-08-10. Anything not listed here is untested, not "known to work".

Do not assume the iOS trap list applies. Most of it is XCTest-derived; Android drives UiAutomator,
and several of the iOS workarounds are simply unnecessary here (see *What is better on Android*).

---

## Device

`Mera_Harness_API35` — created by hand for this harness. **Do not use `Medium_Phone_API_36.1`:**
its system image was never downloaded (`system-images/android-36.1/google_apis_playstore/arm64-v8a`
is an empty directory), so it dies at boot with `FATAL | Broken AVD system path`.

| | |
|---|---|
| API | 35 (Android 15), `google_apis_playstore`, arm64-v8a |
| RAM / cores / data | 4096 MB / 4 / 8 GB |
| Config | `~/.android/avd/Mera_Harness_API35.avd/config.ini` |

Only `platforms/android-35` is installed locally, and there is **no `cmdline-tools`** (no
`sdkmanager`/`avdmanager` anywhere, including inside Android Studio) — so new AVDs must be
hand-authored as a `.ini` + `.avd/config.ini` pair, or created through Android Studio's GUI.

The app targets `compileSdk`/`targetSdk` 36, which is *higher* than the device API. That is fine —
Android allows installing an app whose targetSdk exceeds the device level.

## Prerequisites (every shell)

`ANDROID_HOME` is **not** exported in the user's profile and `emulator` is **not** on PATH. Without
both, `@expo/cli`'s `whichEmulator()` falls back to the bare string `emulator`, swallows the spawn
failure, and reports **zero AVDs** — and `agent-device devices` lists no android target at all.

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
```

## Boot

```bash
emulator @Mera_Harness_API35 -no-boot-anim &      # ~15s to sys.boot_completed
adb wait-for-device
adb reverse tcp:8081 tcp:8081
agent-device devices | grep -i android            # → Mera Harness API35 (android emulator) booted=true
```

## The loop

```bash
cd mera-app                                       # sessions are workspace-cwd-scoped
agent-device open com.mera.news --device "Mera Harness API35" --session android
agent-device snapshot -i --session android
agent-device snapshot --raw --json --session android      # testIDs live here, as `identifier`
agent-device fill 'id=auth-email-input' "text" --settle --session android
agent-device press 'id=auth-language-selector' --settle --session android
agent-device screenshot harness/out/android/foo.png --session android
```

`--session android` is **mandatory** — see the first trap. The package id (`com.mera.news`) is the
correct target on Android, same as iOS; `agent-device apps` reports `Mera (com.mera.news)`.

The `default` session stays bound to the user's iOS device. Leaving it alone is **deliberate**, not
an oversight: `agent-device close --session default` would kill their live iOS harness. Android
always gets its own session name.

## Installing a build

There is no local Android build path: `platforms/android-36`, `build-tools/36.0.0`, and
`ndk/27.1.12297006` are all missing, and `llama.rn` compiles llama.cpp from source via CMake so the
NDK is genuinely required. Use EAS:

```bash
eas build --platform android --profile development     # ~9 min; APK, dev client
eas build:run --platform android --latest              # downloads (389 MB) + installs to the booted emulator
```

`eas build:run` must run from `mera-app/` and does **not** accept `--non-interactive`. It picks the
open emulator automatically when only one is booted.

The `development` profile resolves the EAS `development` environment (confirmed by `eas config`),
which is what supplies `GOOGLE_SERVICES_FILE` — necessary because `google-services.json` is
gitignored and would otherwise never reach the builder. An Android keystore already exists on EAS
(`Build Credentials SfB-njUJ45`), so no interactive credential prompt.

## Launching against Metro

**Reuse the running Metro; do not start a second one.** One instance serves both platforms, and the
iOS harness usually already owns 8081. Check with `curl -fsS http://127.0.0.1:8081/status`.

```bash
adb shell am start -a android.intent.action.VIEW \
  -d "meraapp://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081"
```

Two differences from the iOS URL in [README.md](README.md), both of which will silently no-op if
copied over:

- The scheme is **`meraapp`** ([app.json:14](../app.json#L14)), not `com.mera.news`. `com.mera.news`
  is the *package*; the iOS README's `com.mera.news://…` form does not exist on Android.
- The host is **`10.0.2.2`** — the emulator's alias for the host loopback. The dev-client launcher
  auto-discovers it and shows it with a green dot. `127.0.0.1` also works *if* `adb reverse` is
  live, but `10.0.2.2` needs no setup and is what the launcher itself picks.

On first launch after install the dev-client **developer-menu bottom sheet** covers the app. Press
`text="Continue"` to expand it, then `agent-device back` to dismiss. This is dev-client chrome, not
app UI.

**Corollary for both harnesses:** a JS edit made to drive Android Fast-Refreshes the iOS simulator
too. This is the cross-platform form of the existing "never edit files while the user is typing in
the simulator" rule.

---

## Traps that produce FALSE FINDINGS

**`agent-device` silently drives the iOS simulator when both are booted.** With an iPhone booted and
an active `default` session, `agent-device screenshot` returned a perfectly plausible screenshot of
the **logged-in iOS app** while the Android emulator was still sitting on the dev-client launcher.
`appstate` reported `com.mera.news`, which is true on both. The only tells were the image size
(402x874 with a Dynamic Island vs Android's 1080x2400) and the iOS-only glass tab bar.
Evidence: `out/android/00-TRAP-this-is-the-ios-sim.png`.
→ **Always pass `--session android`, and sanity-check that screenshots are 1080x2400.** Adding
`--device` alone is not enough: the existing `default` session is device-bound and refuses to
switch (`run agent-device close --session default` first — *don't*, that kills the user's live iOS
session; use a separate session name instead).

**`adb exec-out screencap -p` is the independent ground truth.** It cannot target the wrong device
and it does not go through agent-device's session state. When a snapshot and a screenshot disagree,
or when you are unsure which device you are on, this is the tiebreak.

**The "Sprache"/"语言" label on the login screen is not a localization bug.** The word *Language*
next to the language selector cycles through languages by design — the raw snapshot shows it as
`__CAROUSEL_ITEM_9/10/11__` nodes. It will read German or Chinese on an English screen and that is
correct.

**`BILLING_UNAVAILABLE` is the emulator, not the app — and it is not cosmetic.** RevenueCat logs
`PurchasesError(code=PurchaseNotAllowedError, … BILLING_UNAVAILABLE)` because the emulator has no
Google account signed in. RevenueCat itself configures fine and vends `CustomerInfo`. But the error
repeats: it produced **12 stacked LogBox errors** that actively blocked interaction (see the next
three traps). Sign into a Google account on the emulator before treating any purchase-flow
behaviour as real, and expect the LogBox pile on every launch until you do.

**The minimized LogBox toast physically covers bottom-anchored primary CTAs.** Measured:
`consent-accept` occupies y=2173–2274, the toast y=2146–2271. `agent-device press 'id=consent-accept'`
reported `settled` and did nothing — **twice** — because the toast is on top. This reads exactly like
a dead button, and will recur on every bottom-anchored CTA in the app.
→ Close the toast first (`adb shell input tap 996 2208`), then press. When a press "succeeds" but
nothing changes, dump rects from `snapshot --raw --json` and check for an overlay before filing a bug.

**`agent-device react-native dismiss-overlay` does not clear a stack of LogBox errors.** With 12
queued it dismisses one and returns *"dismiss action sent, but verification still detects an
overlay."* Press `text="Minimize"` instead — one action, collapses the whole stack to the toast.

**The expo-dev-client floating FAB has a touch target far larger than its rect.** It reports as
`label="Tools"` at 68x68 (x=910–978, y=77–145), but a tap at (960, 238) — 93px below its bottom edge
and inside the onboarding `Next` button — opened the dev menu instead. This is the Android form of
the documented iOS `gearshape` collision.
→ Drag it away before driving anything in the top-right corner:
`adb shell input swipe 944 110 200 1700 600`.

**`COMMAND_FAILED: Android snapshot helper returned insufficient foreground app content`** happens
during screen transitions. It is not a crash. Retry, or fall back to `adb exec-out screencap`.

**`get attrs` can return stale text right after a `fill`.** A cleared field still reported its old
value while the screenshot showed the placeholder. Trust the `--settle` diff or a screenshot over a
follow-up `get`.

**Snapshots are slower than iOS** — agent-device itself warns `android snapshots are slow in this
run: p95 1548ms`. Per `agent-device help react-native`, if `snapshot` times out because the UI never
goes idle, use `screenshot` as visual truth instead of retrying.

---

## What is better on Android than iOS

Three iOS workarounds documented in [README.md](README.md) are **not needed here**, all verified:

| iOS problem | Android |
|---|---|
| gluestack `InputField` swallows testID → tag the wrapper `Box` | **Surfaces fine.** `testID="auth-email-input"` sits directly on `InputField` ([AuthScreen.tsx:146](../components/custom/auth/AuthScreen.tsx#L146)) and appears as `identifier` on an `android.widget.EditText`. |
| `type`/`fill` impossible → `clipboard write` + tap Paste, and a failure restarts the XCTest runner | **`fill` works directly.** `agent-device fill 'id=auth-email-input' "…"` → `Filled 22 chars`, and the settle diff showed the send button flip `[disabled]` → enabled, proving the text reached React state and not just the native view. |
| Copy changes need patch → forced reload → re-deep-link, ~45s, and *intermittently wedge* | **~12–13s for a copy change, 4/4 consecutive edits landed, none wedged** — see below. |

Status bar is auto-frozen to 9:41 by agent-device — no `simctl status_bar override` equivalent needed.

### Fast Refresh, measured

The iOS README's warning about copy is not "copy never refreshes" — it's that copy refresh
*intermittently wedges*, which is what produced 13 steps of false diagnosis there. One success does
not discriminate "Android is better" from "Android got lucky." So it was run four times, four
consecutive `lib/locales/en.json` edits with **no reload in between**:

| run | landed |
|---|---|
| 1 | ~5s (3s poll granularity — treat as ≤6s, not as the typical figure) |
| 2 | 13s |
| 3 | 13s |
| 4 | 12s |

**Plan for ~13s and expect it to land.** Nothing wedged, so the iOS forced-reload dance
(patch → `sleep 5` → reload URL → `sleep 28` → re-deep-link → `sleep 8`) is not needed on Android
for copy. This is still only four samples on one screen; if a change ever fails to appear, reload
before concluding the code is wrong.

## Command mapping

| iOS | Android |
|---|---|
| `simctl openurl booted "<url>"` | `adb shell am start -a android.intent.action.VIEW -d "<url>"` |
| `simctl terminate booted com.mera.news` | `adb shell am force-stop com.mera.news` |
| `simctl io booted screenshot` | `adb exec-out screencap -p > out.png` |
| `simctl status_bar override` | not needed (auto-frozen) |
| `sqlite3` the WatermelonDB file | `adb shell run-as com.mera.news` — the Play image is production-signed so `adb root` is unavailable; `run-as` works on the debuggable dev build |
| `simctl clone` for a fresh-onboarding state | emulator snapshots, or a second AVD |

## Test accounts and entitlements

There is no resident Android account. A new account is made by logging in with a plus-addressed
email and an emailed OTP (the code goes to a human inbox — this step cannot be automated).

**Play Billing does not work on the emulator**, so a new account hits the paywall
(`NotSubscribedScreen`, "Free isn't free.") and cannot buy its way past it. Grant an entitlement
instead, via the RevenueCat MCP — note this is the **production** RevenueCat project
(`proje32c0249`, the only one), so grants show up in real revenue analytics as promotional
subscriptions.

1. Get the app user id — it is the better-auth `userId` that `Purchases.logIn` sets
   ([revenuecat.ts:270](../lib/revenuecat.ts#L270)):
   `adb logcat -d | grep -i "App User ID"`
2. Grant a `mera-news-*-plan` entitlement. Only these exist in practice — the bare
   `individual`/`professional` ids have archived products behind them and nothing can grant them
   ([revenuecat.ts:55-76](../lib/revenuecat.ts#L55-L76)).

   | tier | entitlement id |
   |---|---|
   | Starter | `entl35fa3aee9d` |
   | Individual | `entlde37d3d481` |
   | Professional | `entlc4dad6be1a` |

   `expires_at` is **ms since epoch** — passing seconds silently grants until 1970. Compute and read
   it back first: `E=$(( $(date -v+30d +%s) * 1000 )); date -r $((E/1000))`.
3. In the app, press `id=not-subscribed-refresh` — `getCustomerInfo()` is cached and will not pick
   the grant up on its own.

**Verify from the device, never from the dashboard.** `get-customer` returning the entitlement only
proves RevenueCat wrote its own record; it says nothing about the server gate (`SubscriptionGuard`,
fed by the RevenueCat webhook → `auth.mera.news`). The real discriminator is
`adb logcat -d | grep server_tier` flipping `none` → the granted tier, and the paywall clearing.
Observed 2026-08-10: grant → `server_tier: professional` within ~10s → paywall replaced by
onboarding. Reversible via RevenueCat's revoke-granted-entitlement endpoint.

The MCP `get-customer` call returned `Something went wrong` immediately after a successful grant
while `list-projects` kept working — **do not read that as the grant having failed.** Check the
device.

## Tab navigation — RESOLVED (2026-08-10)

**Coordinate taps are the only route. There is no usable selector.** Resolved by dumping
`snapshot --raw --json --session android` on the tab tree:

`NativeTabs` renders a real Material `BottomNavigationView`. Every tab item carries
`com.mera.news:id/navigation_bar_item_*` ids and **no `label`, no `text`, and no
content-description at all** — so `label=`, `text=` and the speculative "Android glyph" names
(`view-agenda`, `dashboard`, `explore`, `person`, `settings`) all fail, and the `navigation_bar_item_*`
ids are **repeated once per tab**, so they cannot disambiguate either. Delete the "Android glyph"
column from [README.md](README.md)'s tab table from your mental model; it was never real.

The bar is five equal 216px columns at `y = 2126`, height 211. Tap the centres:

| Tab | Route | Tap |
|---|---|---|
| Feed | `feed` | `adb shell input tap 108 2232` |
| Dashboard | `for_you` | `adb shell input tap 324 2232` |
| Explore | `around` | `adb shell input tap 540 2232` |
| Profile | `profile` | `adb shell input tap 756 2232` |
| Settings | `settings` | `adb shell input tap 972 2232` |

**Which tab is selected IS readable**, so you never have to guess: exactly one column contains a
`com.mera.news:id/navigation_bar_item_active_indicator_view` node. Find it in
`snapshot --raw --json` and its `rect.x` (0 / 216 / 432 / 648 / 864) names the tab.

**The LogBox toast sits on top of the tab bar and swallows every one of these taps.** It occupies
`y = 2146–2271`, i.e. the entire nav bar, and it comes back on each new error (RevenueCat's
`BILLING_UNAVAILABLE` fires repeatedly on the emulator). A tap that "succeeds" and changes nothing
is this, not a wrong coordinate. Close it first — `adb shell input tap 1006 2208` — in the **same**
bash call as the tab tap, because a fresh error can re-raise it within seconds.

## The iOS harness has the same two traps — do not assume they are Android-only

Both were re-observed on 2026-08-10 while driving the pair:

- **The LogBox toast covers the iOS tab bar too.** At `y ≈ 810–850pt` it sits exactly over the
  floating glass pill, and `agent-device tap <x> 820` then reports success and does nothing —
  identical symptom to the Android one above. `agent-device react-native dismiss-overlay
  --session default` clears it (unlike Android, where a 12-deep stack needs `text="Minimize"`), but
  a new error re-raises it, so **dismiss and tap must be one bash call.**
- **`agent-device screenshot` without `--session` returned a 1080×2400 frame** — Android's size —
  while `agent-device session list` reported `default` as `iPhone 17 Pro / 0B26B8EF…`, and
  `agent-device snapshot -i` on the same session returned a node dump prefixed *"Collapsed 26
  Android helper nodes"*. Whatever the cause, the existing rule is the fix and it now cuts both
  ways: **capture with `adb exec-out screencap -p` and `xcrun simctl io booted screenshot`, never
  with `agent-device screenshot`**, and sanity-check every file by size (Android 1080×2400,
  iPhone 17 Pro 1206×2622).
- On iOS you cannot open a second session: `agent-device open --device "iPhone 17 Pro" --session
  <new>` fails `DEVICE_IN_USE by session "default"`. Reuse `--session default` for iOS and
  `--session android` for Android; that is the whole session model.

### Shell trap that reads exactly like "navigation is broken"

`for spec in "1 60" …; do set -- $spec; …` does **not** word-split under **zsh** (the shell these
tools run in), so `$1` becomes the whole `"1 60"` and `$2` is empty. Every `agent-device tap $2 820`
then taps nothing, all five screenshots come back identical, and it looks precisely like a tab bar
that ignores taps. Wrap any loop that relies on word splitting in `bash -c '…'`, or use arrays.

## Known unknowns

- **Everything behind login.** All pre-login results above are unchanged. There is no resident Android account:
  `expo-secure-store` is SharedPreferences + Keystore and app data is wiped on uninstall, so prefer
  `adb install -r` over uninstall, and snapshot the emulator once logged in.
- **The logged-in Android account has NO PERSONA**, so Feed and Dashboard are permanently empty
  ("Mera cannot analyze news for you") and nothing that needs feed content or fact sections can be
  seen there. Explore works — it is a direct server query with no scoring — so use Explore, and
  article detail reached from it, for anything that needs real content. Creating a persona means
  driving the onboarding chat, which needs the cloud LLM.
- Gestures and scrolling now work: `adb shell input swipe 540 1800 540 900 400` scrolls a list
  reliably, and repeated swipes on Explore reveal the collapsing header and the scroll-to-top FAB.
  Alerts/permission dialogs and offline behaviour are still untested.

## Evidence

`out/android/` — `01` launcher, `03` app running from Metro, `05` press expands dev menu,
`06` login screen, `08` after `fill`, `09` press opens language picker, `10` Fast Refresh probe,
plus `snapshot-login.json` (the raw node dump the testID findings came from).

`harness/out/` is gitignored ([.gitignore:103](../.gitignore#L103)), so this evidence is local-only —
same as the iOS harness. Regenerate rather than expecting it in a fresh clone.
