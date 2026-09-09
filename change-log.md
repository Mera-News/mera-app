# mera-app change log

Monthly engineering record. Git holds every commit; what it does not hold is why something was
attempted, what it measured, what was abandoned and for what reason, and what is still unresolved.

One section per month, **most recent first**. Appended at the end of a wave, never per commit.

**This repo's history starts 2026-05-28 at the source-available release.** App development predates
that commit and the earlier history is not in this repo. 2026-05 is the start of the record, not the
start of the work.

**Where the long arcs live:** persona v3 cutover 2026-07 · feed render performance 2026-07 ·
fact check and its two speeds 2026-08 · identity and attestation 2026-08 · tier surfaces 2026-08 to
2026-09.

---

## 2026-09

**Theme:** everything built to mark the free tier gets deleted.

**Shipped:** chat opened on the free tier with every AI tool reachable (09-02), then the distinction
removed entirely (09-07 to 09-09): the tier mirror hydration dropped, the feed-sync gate restated, and
the app now reads its allowance from the server rather than modelling tiers locally. Screen-reader
announcements for the composer's disabled states.

**Rejected and deleted:** `FreeTierCard`, the free-tier read-only banner, the free-tier chat gate, and
every surface still rendering a free trial that no longer exists. All of it was built and removed
inside five weeks as the server-side tier policy moved underneath it.

**Open:** nothing. Tier state is server-owned now, which is why this churn cannot repeat in the same
shape.

---

## 2026-08

The repo's heaviest month, 434 commits, and the month the product got its identity model.

**Fact check, and the pivot to two speeds.** An on-device fact-check runner with its own queue and
schema v52 (08-11), then a split: a quick in-chat search that is ephemeral, and an asynchronous
server-side ClaimReview check that is cached and polled (08-11). A two-layer relevance gate on the
external results (08-18). **Measured:** ClaimReview covers roughly 4% of the corpus, 2,018 of 48,758
tagged articles for election and health combined, and the Fact Check Tools quota is undocumented so a
429 is normal operation. **Rejected:** letting an unavailable ClaimReview lookup block the whole
check, which was the original brief and was backwards, since a lookup that pays off on 4% was killing
100%. Also rejected: treating a 404 from the gateway as a soft failure, since it means no search
happened and conflating the two silently zeroed attribution. Device retention capped at 90 days.

**Identity.** Device sign-in aligned to the server's attestation contract, an identity-switch watcher
at the layout level, logout that preserves the device binding while deletion severs it, a copyable
support id in Settings, and a redesigned welcome flow with separate language, welcome and consent
stages (08-19). **Rejected:** the paywall page, deleted during the redesign, with the free-tier card
becoming the pitch instead. Fetching legal versions at consent-step mount, moved to after device
sign-in. Re-asking a user who had just agreed (08-20).

**On-device inference.** All llama.rn access serialised behind one chain (08-17), and llama.rn pinned
at 0.12.9, moving vendored llama.cpp from b8189 to b10256. **Open:** serialisation is a correctness
fix, not a throughput fix. Concurrent on-device inference is unsolved.

**Relevance and scoring, measured twice, and worth reading as one story.**

*The on-device A/B (08-05).* Two simulators, v1 resident against v3, 321 co-scored articles judged
blind. v3 won recall **32/35 against 27/35**, and its score histogram was flat across 0.4 to 1.0 where
v1 piled up at 0.3 and 0.6. But that recall was measured at the 0.4 render gate, which is too
permissive for v3's spread: 301 of 321 rows passed and half were judge-junk. **At the 0.55 gate that
actually shipped, v3 ties v1 at 27/35.** So v3 is the better foundation, and the win is resolution and
cost (1.0 against 1.24 passes per article), not recall.

*The bars-pinned harness comparison (08-08).* The instrument was rebuilt before any result was
trusted, then reported that v3 scored 2 of 4 pinned bars and therefore did not win: default not
flipped, v1 not deprecated. The finding that mattered came next, that **v1 also scored 2 of 4**. v3's
two failures missed by 0.1pp and by two rows, and v3 led on Pearson (0.642 against 0.617), on recall
at equal feed size (33/37 against 31/37) and on bucket spread, where v1 failed outright with 76.7% of
everything in one bucket. Recorded conclusion: the bars discriminate neither design and need
recalibrating.

*Also this month:* entities changed to rank but never exclude (08-09), and a per-row scoring vintage
flag so a feed-wide gate could not delete rows scored under the old engine with nothing to re-score
them.

**Trap, found on-device and not reproducible in the harness:** the gateway caps the E2EE shared system
prompt at 65,536 characters and the envelope hex-encodes plaintext, doubling it, so any system prompt
over roughly 32.5KB fails at submit. The v3 headline prompt was 35.1KB and hit it. Harness-local
replays bypass the gateway and cannot catch this class of failure.

**Also shipped:** iCloud and Google Drive behind a `BackupProvider` port (08-17), Intercom with a
degrading default, the importance filter as an in-title dropdown, compact card redesign, and
Sentry events carrying a user and a bundle to blame.

**Open:** relevance v3 ships behind a toggle that is off. It stays off because neither instrument
separates it from v1, not because v1 is better; recalibrating the bars is the named next step and has
not been done. A top-K feed budget is documented and deliberately not built, because it needs UI. The
anonymous-account lockout is inherited from the server. Never silently log a user out; only the logout
button logs out, and screens gate on local identity rather than on a session.

---

## 2026-07

**Theme:** the app takes over personalisation. 295 commits.

**The persona v3 cutover.** WatermelonDB v37 persona tables with a silent migration described at the
time as a one-way door (07-17). A deterministic scoring engine re-anchored against golden labels,
which drove a wrong-location error count from 10 to 0 before the cutover was allowed to proceed, then
the cutover itself to persona retrieval with combined arithmetic and judge scoring. A tiered relevance
prompt producing structured output with band clamping (07-16). An eval engine extracted into a tracked
directory so scoring changes gate on golden labels rather than opinion (07-17).

**Story grouping, first attempt.** Union-find collapse with sibling score propagation (07-16), then
keyed on the server's `stableClusterId` with title heuristics as a fallback (07-17), then an entity
edge and ungated stable id to stop one story rendering as several cards. The heuristic is
load-bearing and nobody has beaten it.

**Feed render performance.** Store coalescing, memoised rows, a per-key translation cache, idle sync
(07-19), expo-image behind the single UI image wrapper, virtualised cluster coverage lists, black tab
surfaces to stop a white flash, backdrop memory cut roughly 12x, and images defaulted to disk cache
rather than memory-disk. **Rejected:** FocusFreeze, removed 07-20, because freezing offscreen tabs
cost more than it saved; tabs stay mounted and offscreen work is focus-coalesced instead. The SVG
backdrop on Android, disabled because it crashed and was slow.

**Surfaces.** A 4-tab shell with a notifications route, Explore with country and world scopes, top
stories blend and editions, tracked stories with a timeline and rail, feed card lifecycle states with
a 10-minute eviction sweep, cards widened to a 48h window and grown upward, an optional PIN lock, and
a floating draggable chat bubble replacing the embedded persona chat.

**Rejected:** the Mera Protocol onboarding step (07-15). The geo filter path in Explore, deprecated
07-20 for country and world scopes only. Source-count and relevance badges on cards. Noise injection,
a claim that had copy in 19 locales and no implementation behind it.

**Fixed, and worth remembering:** the scoring pipeline was wedged by an E2EE algorithm mismatch that
threw at encrypt time and blanked the feed. The client saw a bare 500, so the server logs were the
only place the cause was visible.

---

## 2026-06

**Theme:** the app stops consuming server-built suggestions.

**Shipped:** direct article fetching, bypassing article suggestions (06-03), followed by the removal
of suggestion dead code (06-06) once the server dropped the model. A feed-sync state machine with a
new scheduler (06-05). WatermelonDB tables for observability and an observability screen. Saved and
pinned articles, country pinning, and top headlines by country and publication (06-12). Strings
extracted into locale files and the locale set widened (06-09). A content policy and licensing.

**Measured:** a test baseline of 2,433 tests landed 06-11.

**Open:** the jest coverage gate (92 statements / 85 branches) has been red for hundreds of commits.
It is aspirational, not a regression signal. Do not read a red gate as a break caused by the current
change.

---

## 2026-05

**Theme:** the repo opens.

**Shipped:** first public commit 05-28 as a source-available release, with website and repository
buttons and a login deeplink from the OTP email (05-29). A scroll selector on the For You page.

**Open:** the licence is proprietary and the package is UNLICENSED. The code is readable, not freely
reusable, and that distinction has to hold in every piece of copy.
