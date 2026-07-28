# Simulator harness

An agent-drivable instance of the real app: the iOS Simulator (`iPhone 17 Pro`) runs the dev
client with a **resident account** logged in against whatever `.env` points at. Claude (or any
agent with a shell) navigates, taps, and screenshots it via
[`agent-device`](https://github.com/callstackincubator/agent-device) — no human in the loop.

## The loop

```bash
# prerequisites: Metro up (npx expo run:ios --device "iPhone 17 Pro"), sim booted
cd mera-app                      # agent-device sessions are workspace-cwd-scoped — always run from here
agent-device open com.mera.news --device "iPhone 17 Pro"
agent-device snapshot -i         # accessibility tree with @refs
agent-device press @e12 --settle # tap; --settle waits for UI quiescence (use on every mutation)
agent-device screenshot out.png
agent-device close
```

- **Edit → screen is ~6s** via Fast Refresh; no rebuilds unless native deps change.
- `snapshot -i` does **not** display testIDs. Use `snapshot --raw --json` and read the
  `identifier` field, or target directly with `press 'id=<testID>'`.
- Freeze the status bar before screenshotting sequences:
  `xcrun simctl status_bar booted override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3`

## testID conventions

`{surface}-{element}` kebab-case: screen roots `feed-screen` / `dashboard-screen`, tabs
`tab-{route}`, list items `card-${id}` (stable id, not index, where available), actions
`card-action-{name}`. Action testIDs repeat per card by design — scope by card root first.

**Tabs have no testIDs:** `NativeTabs.Trigger` (expo-router/unstable-native-tabs) does not accept
`testID` (verified against its TS types). Drive tabs by their accessibility label ("Feed",
"Dashboard", …) or position instead.

**Placement rule (verified):** testID surfaces as `accessibilityIdentifier` from `Pressable`,
`View`, and gluestack layout components (`Box`, `HStack`, …). It is **swallowed by gluestack
`InputField`** — its wrapper chain is an accessibility container. Put the testID on the
surrounding `Box`/`View` instead. Text entry into gluestack inputs: tap the field's rect
(`snapshot --raw --json` → rect center), then type.

## Resident account

- One real account, plus-addressed email, logged in once via OTP — the session lives in the
  simulator keychain and survives reboots and app reinstalls. The sim is effectively a second
  dev phone.
- Because it's the only identity, `session.user.id` always equals the persisted
  `cached_user_id`, so `clearPreviousUserData()` never wipes local state.
- Backend: whatever `.env` says (prod today; switch to the staging block to test staging).

## Simulator deltas vs a real phone

- **No real APNs.** Push-token registration fails harmlessly (`push_token_fail_streak` absorbs
  it). Silent-push inference wakes never arrive — `inference-recover-task` polls results
  un-gated, so cloud scoring still completes, just on the poll cadence.
- **On-device LLM:** llama.rn is CPU-only on a sim — keep the account on CLOUD processing mode.
- **`EXPO_PUBLIC_FORCE_UPDATE_IN_DEV=true`** (in `.env`) means `NativeUpdateGate` runs its real
  version check even in dev (4s fail-open). If boot ever seems hung, check this first.
- **Paywall:** `FORCE_SUBSCRIPTIONS` is off server-side, so `/logged-in/not-subscribed` is not
  reachable without flag-flipping.

## Reaching interesting states

| State | How |
|---|---|
| Fresh onboarding / empty feed | `xcrun simctl clone` the device; log a second plus-addressed account in on the clone — each sim device is its own container + keychain |
| PIN lock | Enable PIN in Settings → Security |
| Offline | Toggle the Mac's network (the sim shares it) |
| Reauth banner | Revoke the session server-side |

## Gotchas learned during setup

- agent-device holds a per-workspace device lease; a session opened from another directory
  blocks this one (`DEVICE_IN_USE`). Fix: `agent-device daemon stop`, reopen from `mera-app/`.
- A relaunched app (`simctl launch`) can boot on a **stale JS bundle**. Force a Metro reload:
  `xcrun simctl openurl booted "com.mera.news://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`
  (an "Open in Mera?" alert appears — press Open).
- Metro must stay running; it's the `expo run:ios` process. Health check:
  `curl -fsS http://127.0.0.1:8081/status`.
- **Dev-menu gear FAB steals taps** near the top-right (its hit target is much larger than its
  26×26 icon — it swallowed the onboarding "Next" button). Disable it once per install: dev menu →
  scroll down → "Tools button" switch off.
- **Hardware-keyboard mode hides the software keyboard**, so keyboard-avoidance bugs are invisible
  and `fill` still works (types via hardware). Toggle with **⌘K** in the Simulator, or set
  `defaults write com.apple.iphonesimulator DevicePreferences -dict-add <UDID>
  '{ConnectHardwareKeyboard = 0;}'` and reboot the device. Sending ⌘K from a script needs
  macOS Accessibility permission for the terminal.
- **LogBox warning toasts** (dev-only, e.g. the POP_TO_TOP nav warning) sit in front of the app and
  can make a snapshot look like a black screen. `agent-device react-native dismiss-overlay`, or tap
  the toast's ✕. The app is usually fine underneath — check `agent-device logs` before assuming a
  crash.
- **Compact cards merge their children** into one accessibility element (accessible container), so
  child rows inside a card can't be addressed individually — target the card root by
  `id=card-<mongoId>`, then tap child coordinates from `snapshot --raw --json` rects if needed.
- Don't run file-editing subagents while a human is typing in the simulator — every save triggers a
  Fast Refresh that stomps their input.

## Editing files with mixed user WIP

You (the user) often have uncommitted edits in the same tree. Stage by explicit path always; when a
single file mixes harness edits with user WIP (e.g. locale JSONs), stage hunks selectively with
`git diff -U0 -- <file> | <filter> | git apply --cached --unidiff-zero` rather than `git add <file>`.
