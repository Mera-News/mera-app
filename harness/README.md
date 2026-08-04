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
`testID` (verified against its TS types). Drive them by their **SF Symbol id** instead:

| Tab | Route | `press 'id=…'` | Android glyph |
|---|---|---|---|
| Feed | `feed` | `list.bullet.rectangle.fill` | `view-agenda` |
| Dashboard | `for_you` | `square.grid.2x2.fill` | `dashboard` |
| Explore | `around` | `safari.fill` | `explore` |
| Profile | `profile` | `person.fill` | `person` |
| Settings | `settings` | `gearshape.fill` | `settings` |

The Feed tab was `house.fill` until the icon was changed to read as a feed rather than a home —
update any saved script still pressing `id=house.fill`.

Prefer the symbol id over the accessibility label: labels come from `t('tabs.*')`, so they change
with the app language while the symbol id does not. The labels themselves are correct — the Feed
tab's key is still named `tabs.deck` for historical reasons, but its value now reads "Feed" (and
matches that locale's Feed header in all 20 languages).

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
- **All feed/compact cards merge their children** into one accessibility element (accessible
  container), so child controls (`card-action-*`) don't resolve as ids on list screens — target the
  card root by `id=card-<mongoId>`, then tap child coordinates from `snapshot --raw --json` rects.
  (They DO resolve on detail screens and drill-down lists.)
- **iOS share-sheet a11y rects are in the sheet's own coordinate space**, not screen space (`Cell
  "Copy"` can report y=228 while drawn at y≈777). Pressing by @ref/label taps whatever sits under
  the reported rect — often the article behind the sheet, dismissing it, indistinguishable from a
  Copy that wrote nothing. Press share-sheet activities by SCREEN coordinates from a screenshot.
- **Clipboard reads round-trip through host pasteboard sync** (`simctl pbpaste`, `agent-device
  clipboard read`) and can mask or fake an in-app write — verify clipboard content by pasting into
  an in-app text field instead.
- **agent-device serializes its own commands**, so you cannot screenshot mid-gesture with it —
  capture mid-gesture evidence with a concurrent `xcrun simctl io booted screenshot` burst from a
  second shell.

## Traps that produce FALSE FINDINGS

These don't fail loudly — they hand you a confident wrong answer. Each cost real time in r12.

- **Never diagnose scroll, animation or backdrop behaviour on a Fast-Refreshed bundle. Cold launch
  first.** A wedged Fast Refresh keeps *old module state* ticking while remounted components
  subscribe elsewhere: a counter froze and the screen went pixel-identical across step boundaries
  for 13 steps — a perfect "the gate is broken" signature. A cold launch cleared it entirely.
- **`agent-device scroll down` can switch tabs.** Repeated scrolls silently landed on Explore, and
  every subsequent snapshot showed `cards=0` on `explore-list` — read as "blank cells during fast
  scrolling", i.e. a rendering regression that did not exist. Verify the surface by dumping
  identifiers, and prefer coordinate swipes that stay inside the list.
- **Judging collapse/scroll state at a list boundary always reads as a false negative.** A fling
  that runs to the end of the list triggers the iOS rubber-band bounce, which scrolls *up* and
  trips the collapsible header's `UP_THRESHOLD` — so the header reveals and looks like the fix
  failed. Use controlled mid-list swipes.
- **Don't judge or sample any process whose dev menu you've opened.** One such process burnt a flat
  ~36% CPU indefinitely; a cold launch cleared it. It will contaminate any CPU measurement.
- **`press 'id=gearshape.fill'` hits the dev-menu FAB, not the Settings tab** — the SF Symbol id
  collides. Drive the tab bar by coordinates (`y=822`).
- **Relative `--output` paths silently produce no file.** Always pass absolute paths.
- **Gluestack `Switch` does not respond to XCTest synthetic taps at all** — `press @ref`,
  `press 'role=Switch'`, `press 'text=…'`, `tap x y` and `click x y` all report success and leave
  the value unchanged (verify against the DB, not the a11y tree). Route: terminate the app →
  `sqlite3` the `settings` row (`settings(id, _changed, _status, key, value)`, only `value` needs
  changing) → cold launch so `hydrate()` reads it. Distinct from the `InputField` testID note above.
- **Deep list elements exist in the tree only within ~2.5 screens of the viewport** at
  `windowSize={5}`. A fling carries ~1000px against a ~460px window, so an element can appear and
  disappear *between* probes — you cannot binary-search for it. Probe during the fling, or drive
  `scrollToOffset` directly.
- **`all-caught-up-card` and `all-caught-up-explore-cta` are no longer unique** — up to three of
  each render at once (both dividers plus the footer). Scope by the wrapper testIDs, which stay
  unique: `feed-divider-caught-up`, `feed-divider-opened`, `feed-caught-up-footer`.
- **Measuring CPU?** Cumulative CPU time going *backwards* means the PID was reused and the run is
  invalid — guard for it, or a 10-minute soak yields a negative percentage and looks like a bug in
  the sampler rather than a restarted app.
- **A pull-to-refresh gesture that produces zero displacement** usually means an overlay view is
  consuming the pan: `pointerEvents="box-none"` on a container still leaves its CHILDREN touchable
  — full-width text rows in headers become invisible touch bands. Rows must be `none`, containers
  `box-none`, controls `auto` (standing rule documented in the Feed/Dashboard header components).
- Don't run file-editing subagents while a human is typing in the simulator — every save triggers a
  Fast Refresh that stomps their input. (For agent-driving sessions, Fast Refresh can be disabled in
  the dev menu — saves then apply only on explicit reload via the dev-client URL.)
- **`press 'id=…'` fails SILENTLY on an off-screen element.** It reads as MISSING, which is
  indistinguishable from "that testID doesn't exist" — so a perfectly good testID looks like a bug
  in the code under test. `agent-device scroll bottom` first, then press. Bit us on the Advanced
  hub's last two rows.
- **`agent-device back` does not pop an expo-router stack screen.** Tap the header back arrow
  (≈ `(25, 88)` on an iPhone 17 Pro) instead.
- **Text entry into a gluestack `InputField` cannot be done with `type` / `fill`.** XCTest sees no
  text-input element and raises `XCTEST_RECORDED_FAILURE`, which restarts the runner — so it costs a
  session, not just a command. The working route is
  `agent-device clipboard write "<text>"` → tap the field → press the **Paste** menu-item ref.
  (This is separate from the testID-swallowing note above: the wrapper `Box` carries the testID, but
  even once you can *find* the field you still can't type into it.)
- **`agent-device` rejects a UDID** (`DEVICE_NOT_FOUND`); `--device "iPhone 17 Pro"` is the only
  selector that works. That matters because **two simulators share that name** — only
  `0B26B8EF-B252-4E87-8F81-8CAA8597091D` has the app and the resident account; the other is empty.
  Since you can't disambiguate by UDID, boot exactly one and confirm with
  `xcrun simctl list devices booted` before trusting anything you see.
- **The Profile screen's list resists programmatic scrolling** — `scroll` / `fling` / `gesture swipe`
  all failed to move it, and two attempts landed on the tab bar and switched tabs instead. If you
  need something below the fold there, reach it by route rather than by scrolling.
- The resident account is a **test account** (`test-user@mera.news`), not a real one: mutate persona
  state freely and don't bother reverting. Still never log it out, and never `simctl erase` /
  uninstall — the keychain session and the local WatermelonDB are what make the sim usable.
- **`agent-device close` + `open` does NOT restart the app process** — it only cycles the automation
  session, so the JS process (and anything that runs once per process, e.g. a WatermelonDB migration
  or the Feed tab's one-shot hydration) is untouched. A real relaunch is
  `agent-device close` → `xcrun simctl terminate booted com.mera.news` → `agent-device open`.
  Terminating while a session is open can leave the next command failing with `SESSION_NOT_FOUND`;
  `agent-device daemon stop` then `open` recovers it.
- **A migration only logs on the process that runs it.** If the app is already on the new bundle when
  you attach, the migration lines are gone for good — assert the migration structurally (row counts,
  anchor ids) and record the log check as INCONCLUSIVE rather than PASS.
- **The Settings "App Version: v… · \<sha\>" label is frozen at Metro start.** It reads
  `Constants.expoConfig.extra.gitCommit`, evaluated once when `app.config.js` is loaded, so it can
  name an older commit than the JS Metro is actually serving. Never use it to confirm which code is
  running — check for a screen/string that only the newer commit introduces.
- **The Observability screen scrolls only one way**: `agent-device scroll down` jumps straight to the
  content end, and `scroll top`, `scroll up`, `--pixels <n>` and `--duration-ms` are all no-ops on it.
  You cannot park the viewport mid-page for a screenshot. Read the feed-funnel numbers out of
  `snapshot --raw --json` instead — every row is a `StaticText` pair, so sorting nodes by `rect.y` and
  pairing label/value reconstructs the whole table (including rows currently off-screen).
- **`agent-device gesture swipe --from x,y --to x,y` is not valid syntax** — it is rejected with a
  generic "check command arguments" hint that reads like a device problem. Use `scroll`/`fling`.
- **Tab-bar presses are swallowed while a pushed stack screen is on top.** `press 'id=person.fill'`
  from e.g. the Persona-change-log screen silently does nothing (the tab bar isn't in that stack).
  Pop back to the tab root first — one header-arrow tap at ≈(25,88) per stack level — then switch tabs.
- **The Profile list DOES scroll with `agent-device scroll bottom`** (updating the older note above).
  On a fresh launch `profile-row-advanced` sits below the fold, so `scroll bottom` before pressing it —
  otherwise the press fails silently and you'll blame the testID.
- **Whether a feed card exposes its children varies per card.** Some cards surface
  `card-action-*` (and, once a feedback panel is open, `feedback-tree-leaf-*`) as real ids in
  `snapshot --raw --json`; others merge the entire card — overlay panel included — into one
  accessibility element and expose nothing but `card-<id>`. Always snapshot first: if the child ids
  are there, filter by `rect.y` inside the viewport (they repeat once per card, unscoped, and
  off-screen instances report large ± y where `press 'id=…'` silently no-ops). If they're not,
  fall back to screenshot-plus-coordinate-taps for that card.
- **Feed scrolling is coarse and non-monotonic.** One `agent-device scroll down` can move the list by
  several screens, and `maintainVisibleContentPosition` plus a background sync can move a card's
  content-y *up* while you scroll down. Parking a specific card in the viewport by scrolling is
  unreliable — enumerate ids by scanning, but reach a specific card by re-anchoring (`scroll top`,
  then a few steps) and accept it may take several tries.
- **`@eNN` refs re-index on every navigation.** A ref captured before a push/pop can point at a
  different element afterwards (a stale `@e15` opened the wrong Settings row mid-run). Re-snapshot
  immediately before every press, or press by `id=`/`label=`.
- **Cropping a screenshot is the only reliable way to read icon fill state.** Filled vs hollow thumbs
  are ~20px on a 402pt-wide capture and are indistinguishable at full size;
  `PIL Image.crop(...).resize(...)` on the saved PNG makes the difference obvious.

## Editing files with mixed user WIP

You (the user) often have uncommitted edits in the same tree. Stage by explicit path always; when a
single file mixes harness edits with user WIP (e.g. locale JSONs), stage hunks selectively with
`git diff -U0 -- <file> | <filter> | git apply --cached --unidiff-zero` rather than `git add <file>`.
