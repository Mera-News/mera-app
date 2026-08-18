# Auth migration plan

Wave token `auth-wave`. Every phase below is independently deployable and independently revertible.

## Wave status: S1-S3 built and live on staging, 2026-08-17

P-1 through P1 plus the full attestation programme S1-S3 are built on branch `auth-wave` in the three
sibling worktrees, and `auth-wave` is pushed to origin in all three repos. mera-server is merged to
`staging` (merge `ec04ade`) and fast-forwarded on `dev` (`d4e83d6`); staging serves it (revisions
news-auth-staging-00037 / news-graphql-staging-00051 / news-async-staging-00063, all verified live:
dev sign-in mints and resumes, direct `/sign-in/anonymous` 403s, zero error logs). Staging terraform
carries the five attestation env vars (`APP_ATTEST_ENV=development`, team/bundle/package ids, dev
bypass token in gitignored `staging/terraform.tfvars`), and all five manual indexes exist on
`mera-staging` (nonce unique + TTL, device-key keyId/publicKeyPem unique, userId). Simulator e2e ran
against staging via the dev bypass.

S4 (recall bits) remains blocked on user-side externals: DeviceCheck keys and the Play Integrity
device recall beta form (STILL UNSUBMITTED).

Still open, in order:
1. **User: merge** `auth-wave` into the target branches when satisfied (mera-app → `next-binary`,
   mera-server → `main` when releasing, mera-infra → `main`). mera-infra `main` moved ahead by one
   commit (`f3aabec`) after the worktree was cut; different files, but rebase-check it.
2. **User: prod terraform apply** per the P1 checklist (PROMO_EPOCH before 12:00 UTC on the 23rd for
   the D-2 notice; ONE email per user per window) and later the prod attestation env vars
   (`APP_ATTEST_ENV=production`, no bypass token ever).
3. **User: 1.3.0 store release** now carries P0b AND the attestation native module + sign-in flow.
   Real-device App Attest verification against staging first (checklist in the wave report); confirm
   Apple team id `2ZW73WVV7B` and the App Attest capability on the App ID.
4. **User: staging cleanup when done testing**: staging epoch is still time-traveled at `2026-07-30`
   (pinned in the worktree's gitignored `staging/terraform.tfvars`; an apply from any OTHER checkout
   resets it to the 2026-08-11 default and blanks the bypass token).
5. **P3 cohort query on 2026-08-25**, read-only prod, query shown before running — now informational
   (the gate was overridden) but still worth measuring.
6. **Play Integrity device recall beta form** (S4 calendar dependency) and Play Console: enable
   `playintegrity.googleapis.com` + link the Cloud project, or Android sign-ins fall back to
   `integrityUnverified: true`.
7. mera-app worktree carries an uncommitted `package-lock.json` dedupe and staging-pointed `.env`;
   both deliberately uncommitted.

## Why this exists

Email currently does nothing in this product except authenticate. The intent was to remove it for new
users and replace it with device attestation (App Attest on iOS, Play Integrity on Android) minting a
Better Auth session, Better Auth `anonymous()` records as the permanent accounts, and durable per-device
bits (DeviceCheck, Play Integrity device recall) to stop free-trial farming via reinstall.

Scouting the actual code and the actual serving environment changed the shape of that work, for one
reason that outranks all the others.

**The threat has not yet had the opportunity to occur.** `PROMO_EPOCH` is `2026-08-11T00:00:00Z` on the
serving `news-graphql` and `news-auth` revisions, and the grant is
`max(user.createdAt, PROMO_EPOCH) + 14d` (`mera-server/libs/mera-shared/src/billing/promo-grant.ts:11`).
Every user predating the epoch, which is the entire existing base, expires on **2026-08-25**. As of
2026-08-17 no user has ever reached trial expiry, so nobody has had a motive to farm. Raising the epoch
only ever extends grants, so an earlier value would not change this.

So this plan ships only what is correct regardless of the answer, and gates the attestation programme on
the first expiring cohort. The attestation design is specified in full under "Held design" so that
nothing is left to be decided mid-implementation. It is designed, not scheduled.

### Settled and out of scope

- **The persona must never live on Mera's server.** That is the actual invariant, and it is the one that
  matters. Backups the user owns are fine and are being added on purpose: a device-local export and an
  iCloud-based backup are both intended, and `lib/backup/` is that work. So persona data crossing a
  reinstall or a new phone through a user-owned backup is a feature, not a violation. What may never
  happen is persona data reaching our infrastructure.
- The free trial is 14 days and collects no payment method up front. Not a meter, not a store
  introductory offer.

### Decisions already taken

- Path A: ship the no-regret work, gate attestation on the 08-25 cohort.
- Email is removed from onboarding and collected at purchase.
- Intercom `user_id` stays keyed on the Better Auth user id. The entitlement identifier becomes a custom
  attribute for lookup, so existing conversation history survives.
- A client version header is the first phase.
- Read-only prod Mongo is authorised for the cohort query on the 25th, with the query shown first.

## Verified environment, from the serving revisions

Checked with `gcloud run services describe`, not from Terraform, because `terraform apply` is manual in
both roots and both carry known drift.

| | news-graphql | news-auth | news-async |
|---|---|---|---|
| `FORCE_SUBSCRIPTIONS` | `true` | `true` | absent |
| `PROMO_EPOCH` | `2026-08-11T00:00:00Z` | same | **absent** |
| `BILLING_COMMS_SEND_FROM` | absent | `2026-08-13T22:00:00Z` | same |
| `APP_ENV` | `production` | - | - |

`INTERCOM_API_SECRET` has two ENABLED versions, so Intercom is armed in prod. `trial-grant-sweep` is
ENABLED at `0 12 * * *`. `dispatch-billing-notification` is ENABLED at `* * * * *`.

## Facts that overturned parts of the original design

Each of these deleted or reshaped work that was in the original sketch.

1. **`bearer()` is already mounted server-side** (`mera-server/apps/mera-server-auth/src/auth.ts:524`).
   The GraphQL client is cookie-only; the bearer header exists solely for the inference gateway.
2. **Intercom identity verification already ships.** Server-minted HS256 JWT
   (`mera-server/apps/mera-server-graphql/src/modules/intercom/intercom.service.ts:50-98`), re-minted
   before every messenger open (`mera-app/lib/intercom.ts:275-282`), epoch-guarded against a mid-flight
   logout. Every shipped client already sends it, so "turning on messenger security cuts off old
   versions" is a much smaller risk than assumed.
3. **The RevenueCat `TRANSFER` webhook is already handled**, including `transferred_from`,
   `transferred_to` and `aliases` (`revenue-cat.service.ts:390`, `:560-573`).
4. **The Android Auto Backup concern is aimed at the wrong platform.** Android backup scope is already
   narrowed to `shared_prefs` minus SecureStore by expo-secure-store's config plugin, so the persona and
   the session token are out of scope. iOS is where data crosses installs.
5. **Account creation is not unmetered.** Better Auth rate limiting defaults to enabled when
   `NODE_ENV === 'production'`: 100 req/10s globally, `/sign-in*` at 3/10s, and the emailOTP plugin
   overrides `/sign-in/email-otp` and `/email-otp/send-verification-otp` to 3/60s keyed on `ip|path`.
6. **App Attest keys do not survive reinstall, device migration, or restore from backup** (Apple, stated
   explicitly). Attestation is a genuineness check, never a durable identity. Only the DeviceCheck and
   device recall bits are durable. Attestation is therefore not the anti-farming control.
7. **`isExcludedFromBackup` is guidance, not a guarantee**, and Apple warns ordinary file operations can
   reset it, so it must be re-set on every save.
8. **The ban substrate does not exist.** `UserBilling` has no transaction id, no purchase token and no
   Play order id. `originalTransactionId` lives only on an append-only audit collection whose sole index
   is `{provider, eventId}`, with no TTL.

## Standing constraints on every phase

- No forced logout or re-auth for existing email users at any point.
- Client and server versions will be skewed for weeks. Old app versions call the API throughout.
- No new third-party dependency is required by P-1 through P3.
- Cloud Build's deploy step swaps only the image tag. Env vars and secrets come solely from
  `terraform apply`, prod and staging as separate manual applies. Code that hard-requires a new var
  deployed before its apply will crash-loop the service.
- `news-graphql` imports `auth.ts` in-process
  (`mera-server/apps/mera-server-graphql/src/middleware/auth.middleware.ts:16`) and runs its module
  scope, including three hard boot throws. **Any auth env var or plugin change hits two services from one
  file.** This is the most consequential coupling in the repo for auth work.
- Never `git stash`, `git reset`, or `git add -A`. Never push `main`. Never run `terraform apply`. Never
  publish an OTA. Waves end at `dev`, plus `staging` where called for, plus a report.

---

## P-1 Worktree setup. No code.

All work happens on branch `auth-wave` in worktrees **outside** `mera-news`, at
`/Users/abhijeetchakraborty/Code/mera-news-auth-wave/{mera-app,mera-server,mera-infra}`.

Outside, not inside, because `*/worktrees/*` within the tree is a documented trap:
`mera-app/.claude/worktrees/quiet-feed` and `oss-migration-state/worktrees/` are already full duplicate
trees with stale CLAUDE.md copies, every area skill instructs agents never to read them, and greping into
one and editing the wrong copy looks exactly like success.

Base branches: `mera-app` off `next-binary` (the branch in use, and the next store release),
`mera-server` off `dev`, `mera-infra` off `main`.

Gitignored files copied in, enumerated rather than guessed: `mera-app/.env`,
`mera-app/harness-local/.env.harness`, five `mera-server/apps/*/.env`, and `mera-infra/terraform.tfvars`.
Then `npm install` in the two Node worktrees.

Four things that stay in the real tree, because they belong to no branch:

- The root runbooks, including `native-rebuild-plans.md` and `non-native-rebuild-plans.md`. The
  `mera-news` root is not a git repo, so P2's entries pollute nothing.
- The area skills at the root `.claude/skills/`, also unversioned. The fold-back edits them there.
- `ios/` and `android/` are gitignored, so the app worktree has neither. Any build needs a prebuild.

`agent-device` leases are cwd-scoped, so a worktree at a new path binds a different device lease than the
main tree.

**Rollback, which is the whole point:** `git worktree remove <path>` then `git branch -D auth-wave`, per
repo. Nothing on `next-binary`, `dev` or `main` is touched until someone chooses to merge.

### Test baseline, recorded before a single line was changed

Run in the worktrees at their base commits, so any later red is attributable.

| Repo | Base | Suites | Tests | Time |
|---|---|---|---|---|
| `mera-app` | `next-binary` @ `f9ff7b5` | 436 passed, 436 total | 7876 passed, 1 skipped | 142s |
| `mera-server` | `dev` @ `c0fbf9e` | 195 passed, 1 flaky (see below) | 2923 passed, 1 flaky | 149s |

**Both baselines are green.** `mera-server` showed one failure on the first run, but it is a **flaky test,
not a bug**, and the diagnosis matters because the obvious readings are both wrong:
`apps/mera-server-async/src/modules/shared-utilities/mera-worker-host.spec.ts`, test "does NOT discard job
that is exactly at the age limit (boundary)".

The implementation is `waitTimeMs > this.maxQueueAgeMs` (`mera-worker-host.ts:61`), strictly greater, which
**agrees** with the test's intent. The problem is the clock: the spec sets `const NOW = Date.now()` at
module load (`:4`) and builds the boundary job at `NOW - 10 * 60 * 1000 + 100`, a **100ms** margin, while
the host computes `Date.now() - job.timestamp` at execution time (`:58-59`). There are no fake timers
anywhere in the spec. So any load that puts more than 100ms between module evaluation and that test
failing it, which is what happened here because both repos' suites were run concurrently.

Verified by re-running the suite alone: 10 passed, 10 total. The fix is fake timers or a wider margin in
the spec, never a change to the operator. Filed below, not touched.

Note that `mera-app` is fully green here. Project memory records its jest coverage gate as red for 220+
commits; on this branch `npm test` passes, so either the gate has been fixed or it is not part of the
default script. Worth not carrying the stale assumption forward.

---

## P0a Server reads the version header. SERVER-ONLY.

Ships first and alone so the client has something to talk to.

The server currently cannot distinguish app versions at all. GraphQL requests carry `Cookie` and nothing
else (`mera-app/lib/apollo-client.ts:315-329`), `apollo-fetch.ts` adds no headers, and `appVersionInfo`
is outbound only: the client sends a platform enum and the server returns a floor. Every later phase
needs to know who is calling.

**Contract, fixed now.** Header `x-mera-client`. One value, format
`<platform>/<app_version>+<app_build> rt/<runtime_version>`, for example `ios/1.3.0+412 rt/1.3.0`. One
header rather than four, so the log line stays greppable and there is one thing to parse. Absent or
unparseable is always "unknown client", never an error.

**Files:** `mera-server/apps/mera-server-graphql/src/middleware/auth.middleware.ts` to attach it to the
request context; `.../filters/graphql-exception.filter.ts`, which already reads `user-agent` at `:21` and
`:33`, to add the parsed client alongside; plus the request-scoped log context assembly.

**Migrations:** none. **Flags:** none, additive and inert until a client sends it.

**Verify:** unit tests for a valid value, a malformed value and absence. Then a staging GraphQL request
with and without the header, asserting both succeed and that the value reaches the log line.

**If it half-ships:** nothing breaks. An absent header is the current state of every client in the field.

**Rollback:** revert the commit, server-only redeploy. Nothing is written, so rollback is total.

---

## P0b Client sends the header. STORE-GATED, ships with 1.3.0.

**Release classification, settled during P-1.** The code is JS-only and so OTA-capable in principle, but
`runtimeVersion` is `{ policy: "appVersion" }` (`app.json:7-9`) and `next-binary` is at **1.3.0**, so an
OTA published from this branch reaches only 1.3.0 binaries, which in prod is nobody. On this base the
header ships with the 1.3.0 store release and coverage begins as users update.

**Decided: build on 1.3.0.** No OTA will be published to 1.3.0's predecessor for this, so the header
reaches the fleet with the 1.3.0 store release and P3's coverage figures should be read with that in mind.
The alternative of basing this change on the current-prod-binary branch to ride an OTA is closed.

**Files:** `mera-app/lib/apollo-client.ts`, in `authLink` at `:315-329`. That is the only place GraphQL
headers are assembled and the last link before transport. `lib/apollo-fetch.ts` is not touched.

**Reuse rather than rebuild:** `lib/observability/app-context.ts:70-86` already computes `app_version`,
`app_build`, `platform`, `os_version`, `runtime_version`, `ota_channel` and `is_embedded_launch`, and
`lib/revenuecat.ts:189-201` already ships eight of them to RevenueCat. The values exist; only the
destination is missing. The GraphQL request carries no custom header today and the only `X-` headers
anywhere are the four E2EE ones on the gateway transport, so `x-mera-client` collides with nothing.

**Two non-optional requirements:**

- `getStaticAppContext()` is **not** internally guarded and `Updates.updateId` is a native read that can
  throw. `lib/sentry-init.ts:203-218` wraps its own call for exactly this reason. Compute the header
  value **once at module scope inside a try/catch** and reuse it. An unguarded per-request call would
  turn a throwing native module into the failure of every GraphQL request, which is strictly worse than
  the failure mode `sentry-init` was hardened against.
- Import `app-context.ts`, never `runtime-context.ts`. The former is store-free by contract
  (`app-context.ts:18-21`). The latter pulls in five Zustand stores and reaches
  `apollo-client -> auth-client`, which is the cycle `sentry-init.ts:20-28` exists to avoid.

**Do not touch** `readLocalIdentityState` or any keychain key name in this phase. It computes `absent`
from `cached_user_id` and `meraapp_cookie` only, and `absent` is what authorises
`purgeOrphanedLocalData` to erase the user's library at launch (`lib/security/local-wipe.ts:266-287`,
fired from `app/index.tsx:47`).

**Migrations:** none.

**Verify:** unit tests that the header is present and correctly formatted, and that a throwing
`getStaticAppContext` degrades to a missing header rather than a thrown request. No snapshots exist in
the repo and no test asserts the GraphQL header set. `lib/apollo-client.ts` is excluded from
`collectCoverageFrom` (`jest.config.js:41`), so the coverage gate is unaffected. Then one real-device
check that the header arrives and the feed still loads.

**If it half-ships:** old clients send nothing, which P0a tolerates by design. Partial adoption for weeks
is expected and is the reason this phase is first.

**Rollback:** revert and rebuild. The module-scope try/catch means even a broken value degrades to
absence rather than an outage.

---

## P1 Make trial comms exist. SERVER-ONLY plus two manual applies.

`PROMO_EPOCH` is confirmed **absent on the serving `news-async` revision**, so `trial-grant-sweep` runs
daily at 12:00, logs "PROMO_EPOCH is not set - no trial window to sweep", and returns. **No trial-ending
email has ever been sent**, and the first cohort expires on the 25th. This is a conversion bug in its own
right, independent of the auth migration.

**Files:** `mera-infra/cloud-run.tf` (the `news-async` env block),
`mera-infra/staging/cloud-run.tf`, and `mera-infra/staging/variables.tf` if the value is threaded as a
var rather than a literal. No application code changes: the sweep already reads the var and already
early-returns without it.

**Migrations:** none. **Flag:** the env var's presence is itself the flag.

**Rollout order:** staging apply, confirm the early return stops, inspect the outbox row and confirm
`EMAIL_RECIPIENT_OVERRIDE` rewrote the recipient. Then prod apply. `terraform apply` is the user's, never
an agent's; the wave produces `terraform plan` output marked `(NOT applied)`.

**One copy check before the prod apply.** The welcome email is currently the only place the 14-day trial
is mentioned anywhere, and it is direct-send outside the outbox. Turning the sweep on means some users
receive a trial-ending message having never received a trial-starting one. Read the two pieces of copy as
a pair and make the ending message self-contained, so it does not reference a message the user never got.

**If it half-ships:** if the var lands but `BILLING_COMMS_SEND_FROM` or the dispatcher were wrong, rows
would accumulate unsent. Both are verified armed and ENABLED in prod, so the real risk is the opposite:
prod **will** send real mail to real customers on the first sweep after the apply. Staging can never
prove deliverability to a real address, because every recipient is rewritten to one test inbox.

**Rollback:** remove the env var, apply. The sweep returns to no-op on its next run. Already-sent mail is
not recallable, which is why the copy check precedes the apply.

---

## P2 File one identity-in-backup interaction. No code.

**Corrected after review, because the original framing was wrong.** The invariant is that persona data
never reaches Mera's server, not that it never crosses installs. iCloud-based backup is being added
deliberately and `lib/backup/` is that work, so `facts` and `user_personas` surviving a restore or a new
phone is the intended behaviour. There is no product-principle violation here, and the earlier claim that
there was should not be carried forward.

What remains is narrower and real, and it belongs to whoever owns `lib/backup/` rather than to this wave.

`lib/backup/allowlist.ts` draws a deliberate line: `BACKUP_TABLES` carries the persona tables, while
`EXCLUDED_TABLES` and the excluded settings keys drop `cached_user_id`, `cached_user_email`,
`last_authenticated_user_id`, `identity_fault` and `onboarding_state`. `cached_user_id` is annotated as
"identity-gate sentinel — a mismatch triggers wipeAndProceed, so restoring it destroys the restore."

The **platform** backup path does not honour that line. `Documents/watermelon.db` is in device and iCloud
backup scope (Apple documents `Documents/` as backed up, and no exclusion flag exists anywhere in the app,
the config plugins, or the WatermelonDB package), and a platform restore returns the **whole SQLite file**,
including `cached_user_id` and the settings table entire. So the implicit path restores exactly the row the
explicit contract refuses to carry, for exactly the reason that contract gives: a subsequent sign-in by a
different user produces a `wipeAndProceed` verdict that destroys the persona the restore just delivered.

That is the finding: **an unallowlisted platform restore can defeat the allowlisted feature being built on
top of it.** It is an interaction between two backup mechanisms, not an auth problem, and it does not gate
anything in this wave.

Practical constraints for whoever picks it up, established during scouting so they are not rediscovered:

- Setting the flag on the file where it is today is **impossible from JS**.
  `NSURLIsExcludedFromBackupKey` is reachable only through `mkdir` options in
  `@dr.pogodin/react-native-fs` (`ios/ReactNativeFs.mm:326-332`), which is directory-only with no
  per-file setter, and `expo-file-system` has no backup surface at all. An in-place fix needs a config
  plugin and a new binary. Note that excluding the file wholesale would also disable the iCloud backup
  that is wanted, so exclusion is probably the wrong tool here anyway.
- Apple states the flag is guidance rather than a guarantee, and that ordinary file operations can reset
  it, so it must be re-set on every save.
- Relocating the database is JS-only in API terms. `SQLiteAdapter` accepts an absolute path in `dbName`
  and iOS honours it on both dispatchers (`native/shared/Sqlite.cpp:10-18`,
  `objc/WMDatabaseDriver.m:22-34`), using the `/`-prefixed form and not `file://`. But it requires
  refactoring `lib/database/index.ts:32` from a module-eval singleton to a factory or awaited bootstrap,
  plus a synchronous move-if-present migration, and getting that wrong orphans every existing user's
  database and empties every feed until a full re-sync.
- The likelier correct shape is to make identity restoration explicit rather than to fight the file: have
  restore clear or re-stamp the identity keys after a platform restore, so `cached_user_id` cannot outlive
  the device that earned it. That is a `lib/backup/` design decision, not an auth one.

`lib/backup/` and `lib/database/` have an active writer on `next-binary`, so the one-writer-per-path rule
applies against that work too.

**Filed rather than fixed, on evidence:**

- Setting the flag on the file where it is today is **impossible from JS**.
  `NSURLIsExcludedFromBackupKey` is reachable only through `mkdir` options in
  `@dr.pogodin/react-native-fs` (`ios/ReactNativeFs.mm:326-332`), which is directory-only with no
  per-file setter, and `expo-file-system` has no backup surface at all. The in-place fix needs a config
  plugin and a new binary.
- Relocating the database **is** JS-only. `SQLiteAdapter` accepts an absolute path in `dbName` and iOS
  honours it on both dispatchers (`native/shared/Sqlite.cpp:10-18`,
  `objc/WMDatabaseDriver.m:22-34`), using the `/`-prefixed form and not `file://`. But it requires
  refactoring `lib/database/index.ts:32` from a module-eval singleton to a factory or awaited bootstrap,
  plus a synchronous move-if-present migration. Getting that wrong orphans every existing user's database
  and empties every feed until a full re-sync.
- Apple states the flag is guidance rather than a guarantee, and that file operations can reset it.

An app-architecture refactor with a feed-emptying failure mode, for a benefit Apple declines to
guarantee, does not belong inside an auth migration. Note also that `lib/backup/` and `lib/database/`
have an active writer on this branch, so the one-writer-per-path rule applies against that work too.

**Deliverable:** the written entries under "Side findings to file". No code, no migration, nothing to
roll back.

---

## P3 The cohort gate, 2026-08-25. No code.

Read-only prod Mongo, authorised, query shown before it runs.

Measure, on the first cohort whose grant actually ends:

1. Accounts reaching expiry.
2. How many converted to a paid tier.
3. The trial-then-vanish shape: expired, never purchased, no session afterwards.
4. Clustering signals: accounts created in tight windows, patterned email addresses, and identical
   RevenueCat `subscriberAttributes` tuples across distinct accounts.

Item 4 is weak on its own. It is the only farming-shaped signal obtainable without the device substrate
under debate, which is the point.

**Decision rule, fixed in advance so it cannot be rationalised afterwards:** build attestation only if
the trial-then-vanish fraction is both large **and** clustered. Large but unclustered is ordinary
non-conversion, not abuse.

**Zero-cost action to take now rather than on the 25th:** submit the Play Integrity **device recall beta
interest form**. Device recall is gated behind approval before the Play Console toggle appears, so it is a
calendar dependency. Applying now costs nothing and preserves the option; discovering the gate on the
25th costs weeks.

---

## GATE OVERRIDDEN 2026-08-17 — the held design is now active

The user chose to build ahead of the 08-25 cohort data, explicitly. Decisions taken at activation:
- **CBOR via `cbor-x`** (approved dependency), all attestation checks hand-implemented against Apple's
  documented steps and unit-tested. No dedicated verifier library.
- **The 1.3.0 binary WAITS for the attestation native modules.** The user chose holding the binary over
  shipping it now. Trial comms (Aug 23 deadline) are server-side and unaffected; header fleet coverage
  ships whenever this binary does.
- **Anonymous email domain `anon.mera.news`**, welcome email suppressed for anonymous users, billing
  dispatcher treats `@anon.mera.news` exactly like no-email-address (SKIPPED, push still fires). Real
  email written onto the same row at purchase; the plugin's link flow stays forbidden.

### Continuous execution, second directive 2026-08-17

The user directed: do not stop between phases; finish S2 and S3 end to end on staging and test on a
simulator. Stop-for-review is suspended for the remainder of the wave. Decisions taken at this point
so nothing is invented mid-build:

- **Client-facing attestation routes live under the Better Auth basePath**, as endpoints of a small
  server-side Better Auth plugin, so the Expo client's existing cookie handling applies to the minted
  session with zero client transport work. S1's verification services (nonce store, App Attest checks,
  Play Integrity port) are reused as-is; only the HTTP surface consolidates into the plugin. Contract:
  `POST {basePath}/device/nonce` · `/device/attest/ios` · `/device/sign-in/ios` ·
  `/device/sign-in/android` · `/device/sign-in/dev`.
- **Mint-or-resume.** A device key bound to a user resumes that user (internal session creation, so
  `session.create.before` and the deleted-account block still apply, proven by test); an unbound key
  mints via `auth.api.signInAnonymous(...)`. A key bound to another user is never re-bound.
- **Direct `/sign-in/anonymous` is denied by a before-hook** except when the call carries a
  per-process random internal header that only the mint endpoint can supply. Network callers cannot
  know it; it is generated at module scope and never logged.
- **Simulator e2e needs a bypass.** App Attest does not exist on simulators and Play Integrity not on
  emulators. `/device/sign-in/dev` exists only when `DEVICE_ATTESTATION_DEV_BYPASS_TOKEN` is set
  (staging terraform only, never prod; NODE_ENV guards are inert in staging so presence-of-var is the
  gate), constant-time compared. The client uses it only when native attestation is unsupported AND
  `EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN` is set (worktree `.env`, gitignored, never in eas.json).
- **No third-party npm module for attestation.** A local Expo native module
  (`modules/mera-device-attest`) wraps `DCAppAttestService` (Swift) and Play Integrity classic
  requests (Kotlin; `com.google.android.play:integrity` is the unavoidable platform SDK, declared in
  the module's own build.gradle). The ask-first dependency rule stays intact.
- **Android uses Play Integrity classic requests** for sign-in: infrequent, high-value, Google's own
  guidance, and it matches the S1 adapter's `decodeIntegrityToken` path.
- **Email at purchase**: post-purchase sheet, skippable and also reachable from settings, verified via
  the existing emailOTP infrastructure, then written onto the same anonymous row with
  `emailVerified: true`. Never the plugin's link flow.

**Wire contract as built by S2 (final).** All routes under the auth basePath; the client MUST call
them through `authClient.$fetch` (the Expo plugin's cookie persistence is route-agnostic but applies
only to its own fetch). `POST /device/nonce` takes `{purpose}`: `attest` (iOS attestation), `assert`
(iOS sign-in), `integrity` (Android sign-in). iOS sign-in body is `{keyId, assertion, nonce}` (the
nonce is the client data; no separate field). Android sign-in body is `{integrityToken, nonce,
deviceId}` — deviceId is required because Play Integrity verdicts carry no device identity; it is the
resume key, record keyed `play-integrity:<deviceId>`. Dev bypass body is `{token, deviceId}`, keyed
`dev-bypass:<deviceId>`, and the route 404s unless `DEVICE_ATTESTATION_DEV_BYPASS_TOKEN` is set.
Rate limits: 10/60s on `/device/*`, 3/60s on `/device/email/*`, in-memory per Cloud Run instance.
Device-key records gained `userId` (nullable, bound once, never re-bound) — one more manual index per
environment: `db.getCollection('device-key').createIndex({ userId: 1 }, { name: 'userId_1' })`.

### Active phase breakdown

- **S1 — server attestation foundation** (news-auth, no binary): nonce store (atomic
  `findOneAndDelete` consume + TTL GC) and per-device key store in Mongo; App Attest attest+assert
  verification per the documented checks; Play Integrity behind a port with a Google adapter.
  New env vars must be **lazily required** (clear failure at call time, never a boot throw): the
  shared `auth.ts` boot trap and the Cloud Build image-only deploys make a boot-time requirement a
  crash-loop. Tests before implementation, per the standing rule for attestation code.
- **S2 — anonymous sign-in behind attestation** (news-auth + shared libs): mount `anonymous()` with
  `disableDeleteAnonymousUser: true` + `emailDomainName`; deny direct `/sign-in/anonymous` calls via
  a before-hook (the plugin exposes the route; unattested calls must 403); internal mint endpoint:
  verify attestation, then `auth.api.signInAnonymous(...)`; welcome-email suppression; dispatcher
  skip for the anon domain.
- **S3 — client** (auth-wave worktree, rides the held 1.3.0 binary): native attestation modules via
  config plugin (dependency ask happens at S3 start), sign-in flow, `pendingAuthUserId` call site,
  both identity-gate copies, `readLocalIdentityState` untouched (the session cookie name does not
  change). Native queue row added when the module choice is made.
  **Built 2026-08-17, with these deltas from the sketch above:**
  - No config plugin and no npm dependency: `modules/mera-device-attest` is a local Expo module,
    autolinked by expo-modules-autolinking's default `modules/` scan. Swift wraps DCAppAttestService
    with DCError→typed-code mapping; Kotlin wraps Play Integrity classic requests and declares
    `com.google.android.play:integrity:1.4.0` in the module's own build.gradle. Native compile is
    verified at the prebuild step, not in this phase (the worktree has no ios/ or android/).
  - Final HTTP contract as implemented (matches S2's final revision): `/device/nonce` takes
    `{purpose: attest|assert|integrity}`; iOS sign-in body is `{keyId, assertion, nonce}` (the nonce
    IS the client data; SHA256 of the nonce string feeds the native calls); Android sign-in body is
    `{integrityToken, nonce, deviceId}` with deviceId REQUIRED (integrity verdicts carry no device
    identity — a stable SecureStore UUID, shared with the dev bypass, is the resume key).
  - `lib/device-auth.ts` orchestrates through `authClient.$fetch` (cookie persistence is
    route-agnostic there, and only there). Every attempt fetches a fresh nonce; the keyId persists
    only after the server accepts the attestation; ERR_ATTEST_INVALID_KEY clears it and re-enrolls
    once; a keychain READ failure aborts retryable instead of re-enrolling (re-enrolling on a locked
    keychain would mint a second account).
  - Logout severs the device→account link: `_appattest_key_id` and `_device_attest_device_id` are in
    local-wipe's SECURE_STORE_KEYS, because both select an ACCOUNT server-side and must not hand the
    previous user's account to the next person on the device.
  - The third `recordAuthenticatedUser` site is AuthScreen's WelcomeView; device sign-in success also
    clears the identity fault (an assertion is the same re-proof as an OTP).
  - Email at purchase hangs off `refreshUserBillingAfterPurchase` (the chokepoint all purchase
    surfaces share) via a listener registry in `lib/subscription/email-capture.ts`; the sheet is
    also reachable from a Settings row shown only to anonymous accounts.
  - Locale note: en.json had drifted 9 keys ahead of the other 19 dictionaries
    (auth.identitySwitchFailed*, trackedStories.removeMember*), which made `_splice-fragments.mjs`
    refuse every new fragment; healed with `_drift-backfill-fragments.json` before splicing
    `_device-auth-fragments.json`.
- **S4 — recall bits**, flag-gated, blocked on DeviceCheck keys and the Play Integrity beta form
  (STILL UNSUBMITTED — user action).
- One phase at a time, stop for review after each, per the standing rules.

### Fix round, 2026-08-18, from the staging e2e

The simulator e2e (7/7 steps PASS against staging via the dev bypass) surfaced five findings; four
were fixed the same day, test-first, and re-verified on-device:

- **Settings now refreshes in-session after email attach** (was stale until restart). Confirm-success
  writes `userEmail` into the user store synchronously and Settings derives the row and footer from
  one pure `resolveAccountEmailView`, stored-real-email outranking the session. mera-app `9e40d36`.
- **Logout is outage-proof.** Four sites awaited an unguarded `authClient.signOut()` BEFORE
  `clearAuthStorage()`, so a backend outage aborted the local wipe and the device relaunched signed
  in; an existing spec had codified the bug and was inverted. `clearAuthStorage()` is now the single
  server-contact point, guarded and bounded by a 5s race. Invariant recorded in `mera-app-persona`
  (4c): callers never prefix their own signOut. Verified on-device against a blackholed backend,
  twice. mera-app `571ce98`.
- **Email-attach OTP is a SHA-256 digest at rest** (was plaintext, readable from the DB). Legacy
  plaintext rows are burned as expired, never compared. Deployed and verified live on staging
  (row shows `otpHash`, no `otp`; seeded digest confirms; single-use). mera-server `384c813`,
  staging merge `ed12844`. Note the parity fact: better-auth's own emailOTP stores sign-in codes
  plaintext under our config (`storeOTP` defaults to `plain`); flipping to `'hashed'` is one line
  but disables the plugin's `retrieveOTP` path. Left for the user to decide.
- **Device sign-in failures log one structured warn line** (fields only, never nonce/token values).
  mera-app `8bbcc78`.
- **A11y phantom labels, partial by design.** Every app-owned full-screen wrapper answering an
  aggregated "Get started" label is fixed (`accessible={false}`); four remaining phantoms are
  expo-router / react-navigation / react-native-screens content views, non-hittable and never
  focused by VoiceOver — framework aggregation that exists on every screen. Rule: UI automation
  targets testIDs (`auth-get-started`, `auth-use-email`), never text. mera-app `c35f96b`, `4a6fc1b`.

Staging state after the round: mera-server `staging` at merge `ed12844` (serving revisions
news-auth-staging-00038 / news-graphql-staging-00051 / news-async-staging-00063), `dev` at
`384c813`, mera-app `auth-wave` at `4a6fc1b`. E2e residue in `mera-staging`: a handful of throwaway
anonymous users and consumed verification rows, plus test emails in the override inbox.

### S5, 2026-08-18: support IDs and OTP parity

User-requested after the real-device test. Every new anonymous account mints an 8-digit numeric
`supportId` (crypto-random, unique via partial index `supportId_1`, `input: false`), which is also
the anonymous email's local part (`<id>@anon.mera.news`); it survives email attach and rides
`session.user.supportId`. Client shows it in the Settings footer, pre-fills it in the support mailto
body, the Sentry feedback payload (`user.support_id`) and the Intercom custom attributes; the
fabricated address itself is never rendered. Pre-S5 accounts have null and show nothing. Also
`storeOTP: 'hashed'` on the emailOTP plugin (user approved): sign-in codes are hashed at rest and
"resend" now always issues a fresh code, invalidating the old one. Server `6bacc06` (staging merge
`c5778d8`, revision news-auth-staging-00039), client `556af09`, verified on-device (id 95290510,
UI = DB = email local part, zero anon-address leaks).

Refined same day to ADAPTIVE LENGTH (user decision): new IDs mint at 7 digits, escalating 7,7,8,9
across collision retries; validators accept 6-12 digits both sides; uniqueness is enforced solely by
the partial unique index + insert-retry, so digit count only tunes retry frequency and no ID is ever
migrated. Server `a6dab49` (staging merge `71aba4a`, revision news-auth-staging-00040), client
`ff023d5`. Verified live: fresh device minted 7-digit `1264427`; the pre-refinement account resumed
with its 8-digit `19588512` unchanged.

Known cosmetic repeat: the "Before you continue" consent sheet re-arms on deep-links into logged-in
while onboarding is incomplete and swallows taps until accepted. Pre-existing behavior, not from
this wave; noted for whoever owns onboarding.

### S6, 2026-08-18: trial emails killed for everyone, push-only

User decision: no trial-related email to anyone, ever. The dispatcher now skips the email leg for
`trial_ending` / `trial_ended` unconditionally (reason `trial-email-disabled`, checked before the
address logic and before outbox reclaim), push unchanged. Deliberately code, not a flag. Server
`973d039`, staging merge `cac521c`, revision news-async-staging-00064. Verified live with a seeded
sweep-shaped row: email skipped with the new reason, no email-notification row, dispatcher clean.
The welcome email still mentions the 14-day trial (email sign-ups only) — separate user decision.

**PROD ORDERING RULE: merge mera-server `main` BEFORE ever applying PROMO_EPOCH to prod
news-async.** The kill is dispatcher code; the currently deployed prod dispatcher predates it, so
applying the epoch var first would mass-email the cohort with the old code. Epoch-then-merge is the
one order that can still send trial mail.

### S7, 2026-08-18: welcome email off by default, Android dev-build testing enabled

- **Welcome email is gated behind `WELCOME_EMAIL_ENABLED`** (exact string 'true', read lazily; absent
  = no send, logic preserved for the user's future opt-in communication channel). Unset everywhere,
  so no welcome email sends anywhere once this reaches an environment. The S2 anonymous suppression
  stays as an independent layer. With S6, no trial-related text reaches any inbox by default.
- **`PLAY_INTEGRITY_ALLOW_UNRECOGNIZED` (staging only, never prod)**: downgrades exactly the
  `app-not-recognized:*` and `app-not-licensed:*` reason families so sideloaded dev builds can test
  the real integrity path; device-integrity, nonce, package and api-error semantics unchanged.
  Relaxed sign-ins are marked on the device-key row (`integrityRelaxedReasons`, reset per sign-in)
  and warn-logged; `integrityUnverified` now means exactly "api-error present" so outage and
  relaxation never masquerade as each other.
- Staging infra: relaxation var applied (news-auth revision 00042); `sync_news_cron_paused` variable
  added so the ingest pause survives applies (tfvars-pinned true in this checkout, default false).
- Server `7c87a72` + `7406dd3`, staging merge `5fb5003` (revisions news-auth-00042,
  news-graphql-00052, news-async-00065, all verified). Infra `6e8362a` + `b234d7e`.

### S8, 2026-08-18: welcome view rework

User-requested. Final stack: logo band, "Learn about Mera" (outline, identical geometry to the CTA,
navigates to the standalone /tutorials menu, which deliberately sits outside the session gate),
"Get started" (filled), lower band with the tour pill removed on this view only, "Sign in with
email" text link relocated directly above the policy row (recovery path kept after the consequence
was flagged; never hidden), policy/footer. Failure state unchanged (Try again + email + support;
failure escape has its own testID auth-use-email-failure). New i18n key auth.learnAboutMera in all
20 dictionaries. Client `b85922a`, verified on-device (order, outline styling, menu navigation,
email view, sign-in regression all pass).

Open cosmetic items observed repeatedly by the sim rounds, filed for their owners, not this wave:
the email view keeps its own tour pill and has no back affordance (both pre-existing), and the
"Before you continue" consent sheet re-arms on deep links and swallows taps until accepted.

## Held design: the smallest attestation version

Fully specified so nothing is decided mid-implementation. Not broken into phases because it is gated on
P3.

### Verified Better Auth 1.6.16 facts

- `anonymous()` exists at `better-auth/plugins/anonymous`, with exactly six options.
- `isAnonymous` is a real persisted boolean and **already carries `input: false`**, enforced at the same
  `parseInputData` chokepoint as the six existing custom user fields. No client can write it.
- **Ids are adapter-generated Mongo ObjectIds.** The plugin sets no id; the Mongo adapter's
  `customIdGenerator` returns `new ObjectId().toString()`. So `ObjectId.isValid(appUserId)` in the
  RevenueCat webhook passes and **no re-key is needed**. This is what makes the worst landmine free, and
  it is the single most useful finding in the whole review.
- Both `databaseHooks.session.create.before` and `databaseHooks.user.create.after` fire on the anonymous
  path, so the deleted-account block and the persona-row creation both keep working. A `before` hook
  returning false surfaces as a generic `COULD_NOT_CREATE_SESSION`, not our own message.
- `auth.api.signInAnonymous(...)` is the internal mint path, so attestation can verify first and then have
  Better Auth mint through its own path. It refuses if the caller's session is already anonymous, so
  headers must be passed deliberately. It bypasses rate limiting, which is router-level only.
- Unconfigured session defaults, recorded because none are set: `expiresIn` 7 days, `updateAge` 1 day,
  `freshAge` 1 day, cookie cache disabled and force-disabled when a database is configured.

### Two hard rules, both non-obvious

1. **Never use the anonymous plugin's link flow.** Linking creates a **new** user row with a **new**
   ObjectId; it does not upgrade the anonymous one, and `disableDeleteAnonymousUser: true` merely stops
   the old row being deleted rather than causing it to be reused. Because email is collected **at
   purchase**, calling `linkAccount` would fork identity at the exact moment money is involved and orphan
   the RevenueCat `app_user_id`, `user-billing`, `user-persona` and `user-daily-usage`. Write the email
   onto the existing anonymous user row instead, and never call the link endpoint.
2. **Set `emailDomainName` to a domain we control, and suppress the welcome email for anonymous users.**
   The plugin always fabricates an address, and without that option it is `temp@<32-random>.com` on a
   domain we do not own. `EmailNotification.to` is `required: true`, so the row would be created and
   MailerSend would attempt delivery to a random third-party domain, damaging sending reputation.

### Verified platform facts

- **App Attest keys do not survive reinstall, device migration, or restore.** Attestation is a genuineness
  check, never a durable identity.
- Two different counter checks, routinely conflated: at **attestation** the counter must equal `0`; at
  **assertion** it must be strictly greater than the stored previous value. Store the counter after each
  assertion.
- The nonce is **server-generated**, at least 16 bytes, random, one-time, and required for **both** phases.
  Single-use is enforced by an atomic `findOneAndDelete`. A TTL index is a roughly 60-second garbage
  sweep, not the replay defence. Mongo rather than Redis, because `news-auth` has no Redis at all.
- Also verify at attestation: the `x5c` chain to Apple's App Attest root; the nonce against extension OID
  `1.2.840.113635.100.8.2`; the key id against the SHA256 of the `credCert` public key; the RP ID against
  the SHA256 of the App ID; `aaguid`, `validationCategory` and `bundleVersion`. Reject a public key already
  associated with another user. Store the receipt.
- **DeviceCheck:** 2 bits, scoped per **developer account** and not per app, `last_update_time` at
  `YYYY-MM` granularity only, ES256 JWT auth, separate development and production base URLs, device token
  is single-use, and no published numeric quota beyond a 429. The per-account scoping and the
  survives-Erase-All-Content claim come from WWDC21 session 10244, **not** from reference documentation.
- **Play Integrity device recall:** **beta, allowlisted behind an interest form**, 3 bits and not 2, per
  developer account, 3-year retention from last access, write is a server-side `deviceRecall:write`
  spending an integrity token within 14 days, up to 30 seconds propagation plus a fresh warmup before the
  new value reads back, no published numeric write quota, **not supported on emulators**, and requires a
  Play-licensed account or the verdict is unevaluated. Google forbids using it to fingerprint users.
- Re-read Apple's `validating-apps-that-connect-to-your-server` before implementing rather than working
  from this snapshot. The verification list has grown recently.

### Shape

- `anonymous()` with `disableDeleteAnonymousUser: true`, attestation **gating** the sign-in rather than
  supplying a replacement subject.
- The attestation endpoint must mint through Better Auth's own session creation, not hand-craft a session
  row, or `session.create.before` (`auth.ts:490-518`, the single account-status chokepoint, which fails
  open on error) stops applying and the deleted-account block silently dies.
- **`pendingAuthUserId` needs an attestation call site.** It is written only at
  `components/custom/auth/OTPVerificationView.tsx:101` and `DeepLinkVerifyScreen.tsx:46`. Without one,
  `resolveIdentity` returns `coherent` with no effective id and user B enters the shell on user A's facts,
  while the two offline tests named as that line's regression guard stay green. **Both** copies of the gate
  must be updated: `app/logged-in/index.tsx:109-227` and
  `components/custom/onboarding/OnboardingScreen.tsx:151-218`.
- Keep the cookie transport. `bearer()` is already mounted server-side; flipping the client touches
  `apollo-client.ts` and `readLocalIdentityState` and buys nothing.
- The recall bit ships in its own flag-gated reversible phase, never alongside the identity change. The
  bit is set at **account creation**, because the grant is derived from `user.createdAt` and there is no
  trial-start event to hook.
- **The appeal path is device-scoped, not entitlement-scoped.** Bit denial is same-device by definition,
  so mint an opaque support reference at attestation time and surface it on the denial screen. The
  entitlement-derived Support ID in the original sketch does not exist for a trial user with no purchase.
- Failure copy must account for `useSupportAction` opening `mailto:` silently on any failure or after a
  6-second timeout (`lib/intercom.ts:363-398`), so a broken token looks like "support opened my mail app"
  rather than an error.
- Ban policy has to be reconciled with two shipped mechanisms rather than chosen freely:
  `accountStatus: 'deleted'`, terminal via `session.create.before`, and `UserPersona.blockedByLlm` with its
  human-reviewed `UnblockRequest` model.
- Any new user field must carry `input: false`, or a client can set it (`auth.ts:404-410`).
- `intercomIdentity` is in the committed schema and `mera-app/schema.gql` is byte-identical to
  `mera-server/src/schema.gql`, but prod deployment is unproven from the tree. This gates only the held
  design, not P-1 through P3.

## Rejected work, with reasons

- **Server-side rate limiting.** Better Auth's defaults are already on in production and already bound
  `/sign-in/email-otp` to 3/60s per IP. Cross-instance enforcement would need Redis, which `news-auth`
  does not have, or `storage: "database"`, which creates no index on `rateLimit.key` and implements no TTL
  cleanup, giving two unindexed reads plus a write per request on a collection that grows forever. And
  limiting `/token` or `/get-session` would re-arm a documented 429 storm: `getJwtToken()` treats a 429 as
  a transient null with no latch and no backoff (`lib/auth-client.ts:90-98`) while
  `AppScheduler._checkAuthenticated()` re-calls it on every condition evaluation. Not worth it for an
  unmeasured threat.
- **Switching GraphQL to bearer transport.** No benefit, real blast radius.
- **Re-keying the RevenueCat `app_user_id` or the Intercom `user_id`.** Unnecessary once ids are known to
  be adapter-generated ObjectIds.
- **The iOS backup fix inside this wave.** See P2.
- **A forced migration for existing email users.** `emailOTP` stays mounted indefinitely.

## Side findings to file

For `non-native-rebuild-plans.md`:

- **Pending deletions are never purged.** `purge-pending-deletions` exists in code but no Cloud Scheduler
  job triggers it in either Terraform root, and no `ACCOUNT_DELETION_GRACE_DAYS` var exists anywhere.
  Accounts sit in `pending_deletion` indefinitely. Data-retention exposure.
- **One flaky test in `mera-server` on `dev`, failing only under load.**
  `apps/mera-server-async/src/modules/shared-utilities/mera-worker-host.spec.ts`, "does NOT discard job
  that is exactly at the age limit (boundary)". The spec captures `const NOW = Date.now()` at module load
  (`:4`) and builds the boundary job with a **100ms** margin, while the host computes
  `Date.now() - job.timestamp` at execution (`mera-worker-host.ts:58-59`), with no fake timers anywhere.
  Any load that inserts more than 100ms between module evaluation and that test running flips it red. The
  implementation's `>` comparison is correct and agrees with the test's intent, so **the fix belongs in the
  spec**: fake timers, or a margin that is not 100ms. Passes 10/10 in isolation. Found while taking this
  wave's baseline; not touched. Worth fixing because it will fail CI intermittently and train people to
  re-run rather than read.

For `native-rebuild-plans.md`, because both need a new binary:

- **A platform restore can defeat the allowlisted backup feature.** `Documents/watermelon.db` is in device
  and iCloud backup scope with no exclusion, so a platform restore returns the whole file including
  `cached_user_id`, which `lib/backup/allowlist.ts` explicitly refuses to carry because "a mismatch
  triggers wipeAndProceed, so restoring it destroys the restore". Persona portability is intended; identity
  portability is not. Owner is `lib/backup/`. Full constraints in P2 of `docs/auth-migration-plan.md`,
  including why file exclusion is probably the wrong tool given iCloud backup is wanted.
- **The Android backup mitigation is unpinned.** The narrowed scope comes from expo-secure-store 55.0.15's
  config plugin defaulting `configureAndroidBackup: true`, not from anything in this repo, and no test
  asserts it. The plugin bails with a single buried `console.warn` if another config plugin writes
  `android:fullBackupContent` or `android:dataExtractionRules` first, which would silently widen backup
  scope to include the database. Verified that none of the 13 current plugins and no bundled library
  manifest does so today. Add a check, or at minimum a note, so a future plugin addition cannot regress it
  unnoticed.

## Skill updates this wave will make

- `mera-app-persona`: invariant 4b undercounts `clearAuthStorage()` callers. There are five, not four; the
  fifth is `lib/security/local-wipe.ts:212` via `IdentitySwitchFailedScreen.tsx:98`.
- `mera-app-data`: the Map says schema v52, the source is v53. The "5 stores use Zustand persist" claim is
  false; none do, each uses a local helper writing to the `settings` table. `feed-order-store` is in
  `lib/stores/`, not `lib/feed-ordering/`. Add that the WatermelonDB file lands at `Documents/<dbName>.db`
  on iOS and in the data root on Android, that `dbName` accepts an absolute path on both dispatchers, and
  that Android backup scope is governed by expo-secure-store's config plugin rather than by our config.
- `mera-server-async`: record that `news-graphql` imports `auth.ts` in-process. Record Better Auth's
  default rate limits, because "there is no rate limiting" is the wrong mental model. Correct the
  account-purge cadence claim. Delete the reference to `libs/mera-shared/src/encryption/`, an empty dead
  directory.
- `mera-infra`: record that `PROMO_EPOCH` is absent from `news-async` on the serving revision so
  `trial-grant-sweep` no-ops, and that no account-purge scheduler job exists in either root.

## Phase summary

| Phase | Kind | Needs a store release? |
|---|---|---|
| P-1 | worktrees, no code | no |
| P0a | server-only | no |
| P0b | client | **yes, ships with 1.3.0** |
| P1 | server-only plus two manual applies | no |
| P2 | documentation only | no |
| P3 | read-only prod query | no |
| Held design | multi-repo, includes a native rebuild | yes, and it leaves this wave for its own plan |

## Working rules for implementation

- Start each phase in a fresh session with this file as context, and stop after each phase for review.
- Write the test before the change for anything touching attestation verification, entitlement checks, or
  the transfer webhook. None of P-1 through P3 touches those; every held-design phase does.
- If implementation shows this plan is wrong, stop, update this file first, then continue. No quiet
  deviation.
- Never test attestation against production RevenueCat data. Use the sandbox restore-behaviour setting.
- After each phase, hand over the exact by-hand device checks. Emulators do not exercise Play Integrity,
  and device recall is explicitly unsupported on emulators.
