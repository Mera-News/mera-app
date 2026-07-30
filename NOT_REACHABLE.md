# NOT_REACHABLE — reachability audit of the `feature/not-interested-filters` wave

Audited: 51 commits, `b0b8605..HEAD` (196 files, ~21k lines).
Scope: everything this wave BUILT that no user can actually reach.

**Rule used throughout: tests are not callers.** A symbol whose only references
live under `__tests__/` or `*.test.ts` is unreachable. "It has tests" is exactly
what made the server's `tag-articles-fanout` feel shipped for months while it had
never once executed.

## Summary

**14 unreachable items** across categories A–E, plus **3 findings that are worse
than dead — actively wrong**, listed at the end.

**The most consequential item for users is D1: article tagging has never run, in
either environment.** There is no `tag-articles-fanout` (nor its renamed
successor `pre-process-articles-fanout`) Cloud Scheduler job in *either*
`mera-infra/cloud-scheduler.tf` (prod) or `mera-infra/staging/cloud-scheduler.tf`.
The processor is built, tested, and wired into `async.module.ts` on server `main`
— nothing fires it. Consequently `geo_tags` / `entities` / `event_type` are
unpopulated in production, and that single fact kills three feedback-tree leaves
outright, makes three of the seven suppression `kind`s unmatchable, and routes
100% of production articles to the legacy LLM scoring path. This wave's own
`EXPO_PUBLIC_USE_ARTICLE_TAGS=false` default (C1) independently enforces the same
outcome, so there are two locks on the same door.

A note on honesty: **`clusterSize` and `geoText` are NOT dead** — this wave fixed
them, and I verified the fix. The wave's planning notes listed them alongside
`hasGeoMismatch` as having no producer; that is no longer true for two of the
three. Only `hasGeoMismatch` remains producerless. Where I could only prove a
thing is *conditionally* reachable, I say so rather than padding the list.

---

## A. No caller

### A1. `getActiveScopes` — zero references anywhere
`lib/database/services/publication-preference-service.ts:284`

Evidence: `grep -rn -w getActiveScopes lib components app hooks` returns exactly
one line — the declaration itself. No test references it either.

Its doc comment claims it is "what the render-time context loader consumes", but
the render-time loader does the filtering inline instead:
`lib/user-context/user-geo-language-context.ts:95` calls `getActive()` and
branches on `p.scopeKind === 'country'` itself.

Unblocking step: either delete it, or have `user-geo-language-context.ts:88-100`
call it so the scope/named-publication split has one definition.

### A2. `getActiveNamedPublications` — referenced only inside a comment
`lib/database/services/publication-preference-service.ts:291`

Evidence: the only non-declaration hit is `lib/mera-protocol/stage-scoring.ts:63`,
and it is prose, not a call — the comment explicitly explains why the function is
*deliberately not* imported ("a narrower `getActiveNamedPublications()` import
would put the guarantee somewhere the two call sites can't show it").

This is dead by design and the rationale is sound. Listing it because dead-by-
design is still dead: the function is a maintenance liability that will drift
from the two inline filters it is supposed to mirror.

Unblocking step: delete it and keep the comment, or adopt it at both call sites.

### A3. `setHeadlineDepth` / `clearHeadlineDepth` — no caller at the committed tip
`lib/database/services/headline-depth-service.ts:68` and `:77`

Evidence: at `HEAD`, the only callers are in files that are **untracked or
uncommitted**:
- `components/custom/headline-depth/headline-depth-model.ts:97,100` — directory
  is `?? untracked`
- `app/logged-in/headline-depth.tsx` — `?? untracked`
- `components/custom/profile/AdvancedHubScreen.tsx:290,294` (the hub row that
  routes to it) — ` M` modified, not committed; `git show
  HEAD:components/custom/profile/AdvancedHubScreen.tsx | grep headline-depth`
  returns nothing.

So as committed, the whole per-scope headline-depth feature (commits `848c4a7`,
`bfef481`) has **no entry point**: `getHeadlineDepths()` is read on every feed
sync (`lib/scheduler/feed-sync/feed-sync-steps.ts:160`) and can only ever return
`{}`, because nothing can write a row.

Another agent is landing the caller as this audit is written. Listed anyway,
because the wave shipped the storage + the read + the wire-through in three
commits before the writer existed — and because when the writer lands it
immediately activates D2 below, which is a latent production outage.

Unblocking step: commit the `headline-depth` screen + its route + the hub row.
**But fix D2 first.**

---

## B. No producer

### B1. `hasGeoMismatch` — nothing ever sets it, so "Wrong place" is permanently hidden
Consumer: `lib/news-harness/feedback-tree/evaluate-condition.ts:29-31`
Type: `lib/news-harness/feedback-tree/types.ts:125`
Gated node: `lib/services/feedback-tree-snapshot.ts:109-115` (`wrong_place`,
`visibleIf: { has_geo_mismatch: true }`)

Evidence: `grep -rn hasGeoMismatch` over the whole repo returns **four** hits —
the type declaration, the condition check, and two lines in
`__tests__/evaluate-condition.test.ts`. Not one of the three context builders
sets it:
- `components/custom/feed/InlineFeedbackTree.tsx:120-134` (`buildLocalContext`)
- `components/custom/news-detail/detail-feedback-context.ts:116-133`
- `components/custom/cards/overlay-context.ts:36-70`

All three set `category`, `clusterSize`, `geoText`, `matchedTopics`,
`publicationVisits`, `eventType` — and none sets `hasGeoMismatch`.

Because `evaluateCondition` returns `false` when the flag is absent, and because
this wave taught `useFeedbackTreeEngine` to *hide* rather than merely no-op
(`isVisibleNode`, `useFeedbackTreeEngine.ts:67-71`), the **"Wrong place" option
is invisible on every article, on every surface, for every user.** It is not a
useless button — it does not render at all.

Unblocking step: compute `hasGeoMismatch` in the three context builders (compare
the article's `geo_tags` against the user's `locations`) and set it on
`LocalFeedbackContext`. Note this *also* requires D1 — with no `geo_tags` there is
nothing to compare.

### B2. Suppression kinds `place`, `entity`, `topic` — matcher built, no writer
Matcher: `lib/news-harness/scoring-engine/suppression.ts:100-122`
Allowed by schema: `lib/database/models/PersonaSuppression.ts:32-42`
Rendered in the UI: `components/custom/not-interested/SuppressionRow.tsx:25`
(a `place` icon)

Evidence: grepping every site that constructs a suppression, the only `kind`
values ever written are:
- `'category'` — `feedback-tree-snapshot.ts:170`, `feedback-digest.ts:452,591`
- `'event_type'` — `feedback-tree-snapshot.ts:185`, `feedback-digest.ts:431,574`
- `'publication'` — `stage-scoring.ts:234` (mute synthesis),
  `persona-action-executor.ts:419`
- `'keyword'` — the chat path, `AddPhraseModal`, and the `from_context_title` leaf

No site writes `'place'`, `'entity'` or `'topic'` from the app's own UI. The
hand-entry modal is keyword-only by explicit design
(`components/custom/not-interested/AddPhraseModal.tsx:31-33`).

Partial reachability, stated precisely: the **ArticleFeedbackAgent** *can* emit
`kind: 'topic'` and `kind: 'entity'` — its tool schema exposes
`suppressionKind`/`suppressionValue`
(`lib/news-harness/article-feedback/agent-core.ts:556-565`) and its enum is the
full `SUPPRESSION_KINDS` list. So **`topic` is reachable via chat** (`<context>`
carries a `MATCHED TOPICS` block it can copy from). `entity` is not, in practice —
see D1, the `Entities:` line is only emitted `if (entities.length > 0)`
(`agent-core.ts:382`) and entities are empty in prod. `place` is category E — see
E1.

Unblocking step: for `place`, add a `Place:` line to the agent `<context>` and a
provenance mapping in the prompt; for `entity`, D1.

### B3. `headlineScope === 'CITY'` — handled, never requested
`lib/stores/fact-rows-selector.ts:~293` (`headlineSectionIdOf`) explicitly handles
and drops the `CITY` scope; `lib/news-harness/scoring-engine/retrieval-profile.ts:
214-226` only ever builds `COUNTRY` and `GLOBAL` scopes. The comment concedes it:
"never requested as its own retrieval scope".

Low impact — a defensive branch, correctly written. Noted for completeness, not
as a defect.

---

## C. Gated off

### C1. `EXPO_PUBLIC_USE_ARTICLE_TAGS` defaults to `false` — the entire math scoring path is dead
Flag: `lib/config/endpoints.ts:95-96` (`=== 'true'`, so anything else is off)
Default: `lib/news-harness/core/config.ts:375` (`USE_ARTICLE_TAGS: false`)
Shipped default: `.env.example:+8` (`EXPO_PUBLIC_USE_ARTICLE_TAGS=false`)

With the flag off, `applyArticleTagPolicy`
(`lib/news-harness/scoring-engine/tag-policy.ts:73-76`) returns
`{ ...input, geoTags: [], entities: [], eventType: null }` for every candidate,
applied at the composition seam `lib/mera-protocol/stage-scoring.ts:295`.

`isBackstop()` (`lib/news-harness/scoring-engine/relevance.ts:266-272`) tests
emptiness of exactly those three fields. (Per the brief: this predicate is
**correct** — testing emptiness is what makes schema-default empty arrays read as
"untagged". Not a bug, and not reported as one.) But the consequence is total:
**every candidate is `mode: 'backstop'`**, so at
`lib/news-harness/scoring-engine/run-stage.ts:171-172` `mathItems` is always empty
and `backstopItems` is everything.

Therefore the following are unreachable in every shipped build:
- The **judge pass** — `run-stage.ts:176` is guarded by `mathItems.length > 0`.
- `judgeScoreMap` — always empty.
- **Judge-authored reasons** (`run-stage.ts:71`) — never produced.
- The deterministic math score as the *applied* score — `run-stage.ts:170`
  computes it, then the backstop legacy LLM score overwrites it.
- Suppression kinds `event_type`, `entity` and `place` at match time — the
  matcher reads `candidate.eventType` / `.entities` / `.geoTags`
  (`suppression.ts:98,101,111`), which the tag policy has already blanked.
- The `entities` segment of the keyword haystack (`suppression.ts:51`) — so even
  plain keyword filters silently match against a narrower haystack than the
  matcher's byte-identity contract describes.

The same gate is applied to the retroactive suppression sweep
(`lib/services/suppression-sweep.ts:112-114`, commit `0c69adc`), so the sweep
inherits all of the above.

Unblocking step: set `EXPO_PUBLIC_USE_ARTICLE_TAGS=true` — **but this alone
changes nothing**, because D1 means the fields it stops stripping are empty at
source. Both locks must be opened, in the order D1 → C1.

---

## D. Requires an unshipped dependency

### D1. Article tagging has never run — no cron exists in either environment ★ most consequential
Server processors (present on `main`, i.e. in production):
- `apps/mera-server-async/src/modules/sync-news/processor-tag-articles-fanout/`
- `apps/mera-server-async/src/modules/sync-news/processor-tag-articles/`
- registered at `apps/mera-server-async/src/async.module.ts:15`
- queue id `TAG_ARTICLES_FANOUT = 'tag-articles-fanout'`
  (`libs/mera-shared/src/constants/queue-names.enum.ts:17`)

The processor's own header states how it is meant to fire: "fired by a Cloud
Scheduler cron via `/invoke {queue_name: tag-articles-fanout}`"
(`tag-articles-fanout.processor.ts:12-13`).

Evidence that it does not: `grep -rn queue_name --include=*.tf` across
`mera-infra` returns the complete set of scheduled queues in **both** roots —
prod (`cloud-scheduler.tf`): `news-sync-fanout`, `link-all-topics-to-clusters`,
`push-notification-hourly-all`, `cleanup-redis-bull`, `data-retention-sweep` ×2;
staging (`staging/cloud-scheduler.tf`): `news-sync-fanout`,
`link-all-topics-to-clusters`. **Neither `tag-articles-fanout` nor
`pre-process-articles-fanout` appears in either file.** The renamed successor
(server `dev`, commit `15b4320`) is additionally described in its own commit
message as "wire it off-by-default", and is not merged to `main` at all.

Corroborating data shape (staging DB `mera-staging`, read-only): a whole-
collection `findOne({ category: { $exists: true, $ne: null } })` returns **no
document** — `category` is set on zero articles. A natural-order article document
has no `geo_tags`, `entities` or `event_type` key at all. (Recent staging
articles *are* partly tagged — 60% `geo_tags`, 79% `entities`, 99% `event_type`
on the newest 300 — which is the signature of the manual
`pre-process-articles-backfill` command the server `dev` branch added and
measured, not of a scheduled job. No such command exists on `main`.)

What this makes dead, beyond the C1 list:

- **`this_kind_of_event` leaf** — `feedback-tree-snapshot.ts:175-188`. Doubly
  gated: `visibleIf: { has_event_type: true }` fails, and even without the gate
  `resolveLeafActions` would return `[]`, so `isInertActionLeaf`
  (`useFeedbackTreeEngine.ts:39-44`) hides it. **Permanently invisible.** The
  snapshot's own comment already concedes this ("the server populates
  `event_type` on none of ~303k rows").
- **`more_news_from_place` like-leaf** — `feedback-tree-snapshot.ts:228-236`.
  Mints `add_negative_topic` from `from_context_geo`, which reads `ctx.geoText`
  (`resolve-leaf-actions.ts:84`), which comes from `geoTextFromTags(geo_tags)`.
  With no `geo_tags`, it resolves to `[]` and `isInertActionLeaf` hides it.
  **Permanently invisible** — see W2 below, the code comment claiming otherwise
  is now wrong.
- **`wrong_place`** — already dead via B1; D1 is the second, independent cause.
- **`kind: 'place'` / `kind: 'entity'` / `kind: 'event_type'` filters** — nothing
  to match against even if one could be created.

Unblocking step: add the `:40` Cloud Scheduler job to *both*
`mera-infra/cloud-scheduler.tf` and `mera-infra/staging/cloud-scheduler.tf`
(manual `terraform apply` — this repo has no CD for infra), or merge the server
`dev` pre-process stage and enable it. Then C1.

### D2. `HeadlineScopeInput.limit` is not in the production schema — latent whole-feed outage
App: `schema.gql:183` declares `limit: Int` on `HeadlineScopeInput`.
Server `main` (= prod): **does not have it.**

Evidence:
`diff <(cd ../mera-server && git show main:src/schema.gql) schema.gql` yields
exactly two lines, one of which is `> limit: Int` at 183. The field exists only
on server `dev` and `staging` (added by `40d7824 headlines P1`), which are ahead
of `main`.

Why this is worse than a missing feature: the headline scopes ride **inside the
same GraphQL operation as topic retrieval** —
`GET_ARTICLE_IDS_FOR_PERSONA` (`lib/article-service.ts:459-479`) is one
`articleIdsForPersona(query: $query)` call carrying both `topicResults` and
`headlineResults`. `feed-sync-steps.ts:213` spreads `limit` into each scope
entry. A field the server's schema does not declare fails **input validation for
the entire operation**, not just the headline half. And there is no fallback:
`feed-sync-steps.ts:222` is a bare
`await withRetry(() => ArticleService.getArticleIdsForPersona(query), ctx.signal)`
— a validation error propagates out of `fetchTopicIdsPersona` and kills the feed
sync wholesale.

This is currently **latent** only because A3 means no user can create a depth
override, and `buildRetrievalProfile` emits `limit` solely where an override
differs from the default (`retrieval-profile.ts:217-226`). **The uncommitted
headline-depth screen arms it.** The first user who changes a scope's depth on a
build talking to prod gets an empty feed — not a default-depth feed.

Unblocking step: merge server `dev`→`main` (or at minimum the `HeadlineScopeInput.
limit` schema change) and deploy prod **before** the headline-depth screen is
committed. Defence in depth: catch `GRAPHQL_VALIDATION_FAILED` in
`fetchTopicIdsPersona` and retry once with `limit` stripped from every scope.

---

## E. Reachable only via a path the UI never offers

### E1. `kind: 'place'` suppressions — in the agent's enum, absent from its evidence
Enum the agent may emit: `lib/news-harness/core/types.ts:167-175` — includes
`'place'`.
Tool schema: `lib/news-harness/article-feedback/agent-core.ts:556-565`.

But the prompt's value-provenance mapping — the contract that tells the agent
where a `suppressionValue` may legally come from — lists only four kinds:
"category ← Category, entity ← Entities, publication ← Publication, topic ←
MATCHED TOPICS" (`agent-core.ts:300`, restated at `:565`). There is no `place`
mapping, and the `<context>` block the agent reads emits no `Place:` line
(`agent-core.ts:376-407` emits `Publication:`, `Category:`, `Entities:`, and a
`MATCHED TOPICS` section — nothing else).

The prompt then forbids the only remaining route: "A value you paraphrase or
invent matches NOTHING." So a well-behaved agent cannot produce a `place` filter,
and a misbehaving one produces a filter that matches nothing. The `place` branch
of the matcher (`suppression.ts:106-117`) — including its careful
publishing-country-vs-story-geo distinction — is unreachable from any surface.

Unblocking step: emit a `Place:` line into `<context>` from the article's
`geo_tags` and add the `place ← Place` provenance mapping to the prompt. Requires
D1 for the data.

Deliberately **not** listed here: the `PersonaUpdateAgent` cannot emit
`suppressionKind`/`suppressionValue` either — but that is intentional and
documented (`lib/news-harness/persona-management/persona-agent-core.ts:433`,
"intentionally DROPPED here"), and the ArticleFeedbackAgent covers the case.
Verified reachable, not a finding.

---

## Verified reachable — checked and found NOT dead

Recorded so the dead items above are credible by contrast.

- **`clusterSize`** → `nudge_browse_related` (`cluster_size_gte: 2`) and the
  `paywall` branch. Producer exists: `article-suggestion-service.ts:986` reads
  `row.maxClusterSize`, fed from the GraphQL `maxClusterSize` field
  (`article-service.ts:478`), and clustering genuinely runs in prod (the `:20`
  `cluster-news` cron is in `cloud-scheduler.tf`). Consumed at
  `InlineFeedbackTree.tsx:118` and `overlay-context.ts:52`. **This wave fixed it.**
- **`geoText`** → producer at `article-suggestion-service.ts:990` and
  `detail-feedback-context.ts:116`. The *code* path is wired correctly and
  completely; it yields null in prod only because of D1. Category D, not B — the
  distinction matters, because shipping the cron fixes it with no app change.
- **`this_category` leaf** — reachable, but only on ~26% of articles by design.
  `isDiscriminatingCategory` (`category-specificity.ts:101`) mints nothing for
  the generic "news" family. Verified against staging `publication-source`:
  `general_news` = 672 sources vs `Tech` 16, `Programming` 11, `Cricket` 10…
  matching the measured 73.9% generic share documented at
  `category-specificity.ts:15-22`. A deliberate, well-evidenced gate, not a defect.
- **`kind: 'topic'`** via ArticleFeedbackAgent — see B2.
- **Source-scope preferences** (`set_source_scope_pref`) — producer at
  `persona-agent-core.ts:495` and `proposal-handlers.ts:205`; consumer at
  `user-geo-language-context.ts:95`; executor at
  `persona-action-executor.ts:457`; revert at
  `persona-change-log-service.ts:291`. Full loop verified.
- **Hard-filter headline exemption** — see W3; implemented as specified.

---

## Worse than unreachable — actively wrong

### W1. `tag-policy.ts` documents a factual claim that is false, and it is load-bearing
`lib/news-harness/scoring-engine/tag-policy.ts:64-67`:

> `category` is deliberately NOT stripped: it is not part of the untagged
> predicate, **it is populated today** (so clearing it would be a live behaviour
> change, not a preserved one), and the `category` suppression kind depends on it.

The *article's* `category` field is populated on **zero** documents — a whole-
collection `findOne({ category: { $exists: true, $ne: null } })` on staging
returns nothing, and the field is absent from the document keys entirely.

The decision it justifies is nonetheless **correct**, for a reason the comment
does not give: the app's `category` is not the article's field at all, it is the
**publication source's** category, joined server-side
(`articles-for-topics.dto.ts:147-150`, filled at
`articles-for-topics.service.ts:1035` from `pub?.category`). *That* is populated.
So the behaviour is right and the stated reason is wrong — which is the dangerous
combination, because the next person to reason from this comment (e.g. to decide
whether `category` belongs in the untagged predicate) will reason from a false
premise. Note `category-specificity.ts:8-13` gets this exactly right; the two
comments contradict each other.

Impact: no user-visible breakage today. Fix the comment, don't change the code.

### W2. A stale comment now describes the opposite of what the code does
`lib/services/feedback-tree-snapshot.ts:232-234`, on `more_news_from_place`:

> No visibleIf: has_geo_mismatch is dislike-specific ("wrong place"); there's no
> clean inverse. **Shown unconditionally — the leaf no-ops client-side when
> there's no geoText.**

That was true before this wave. It is not true now: `isInertActionLeaf`
(`useFeedbackTreeEngine.ts:39-44`, added by commit `4430494`) hides any
action-declaring leaf whose actions resolve to nothing, and this leaf's single
action resolves to nothing whenever `geoText` is null — i.e. always, in prod.
The leaf is **hidden**, not shown-and-inert.

Impact: the hiding is the better behaviour, so this is a documentation defect
rather than a user-facing one. But it means "More news from this place" silently
vanished from the thumbs-up tree in production, and the comment would lead a
reader to conclude it is still rendering.

### W3. `isHardFilterExempt` — answering the coordinator's question: **exclusion only. Demotion is correctly implemented.**
Requirement, verbatim: *"No. let it. may be deprioritise it but keep it as it's
unescapable for the user."*

The exemption is **exempt-from-exclusion**, and exempt rows **are** still
penalised. Evidence:

1. `lib/news-harness/scoring-engine/suppression.ts:143-145` — the predicate,
   `candidate.headlineScope != null`.
2. `suppression.ts:176` — `screenHardSuppressionsDetailed` routes an exempt match
   to the `exempted` map, not `excluded`; only `excluded` is returned by the
   `screenHardSuppressions` wrapper (`:195-200`) that the drop sites use. So the
   row survives the hard screen.
3. `lib/news-harness/scoring-engine/relevance.ts:362-370` — for an exempt row the
   matching **hard** filters are appended to the soft list and run through the
   *same* `suppressionPenalty` call. The row is demoted, through one matcher and
   one `P_SUP_CAP`.
4. `relevance.ts:397-399` — the final score is then floored at
   `HEADLINE_BASE_FLOOR`, so the penalty cannot sink it below the 0.3 render gate.

So both halves of the requirement hold: kept, and deprioritised. **No defect.**

One nuance worth the user's attention, reported not as a bug but as a design
consequence: because of step 4 the demotion is a **pin, not a slope**. One hard
filter is `P_SUP × 1.0 = 0.3` against a `0.35` floor, so any exempt headline —
whether it matched one filter or five — lands at exactly `HEADLINE_BASE_FLOOR`.
It sorts below every unfiltered headline (which additionally earns
`HEADLINE_POP_LIFT · popComp` plus its own `mathBase`) and below every topically
relevant article, which satisfies "deprioritise". But a headline matching five of
the user's filters is ranked identically to one matching a single filter. The
comment at `relevance.ts:391-397` shows this was a considered trade, not an
oversight.

---

## Method

Four mechanical sweeps rather than suspect-grepping, so the list is complete
rather than anecdotal:

- **A** — `git diff b0b8605..HEAD` over non-test paths → `grep '^+export'` → 119
  new exported symbols → each grepped for non-test, non-declaration references.
- **B** — every new string/field a consumer keys off, enumerated from its
  consumer and traced back to a write site: the `SUPPRESSION_KINDS` union, every
  `ACTION_NAMES` entry, every `visibleIf` key in `evaluate-condition.ts`, every
  proposal action type in `proposal-handlers.ts`.
- **C** — every new flag/constant read for its shipped default (`.env.example`,
  `core/config.ts`, `lib/config/endpoints.ts`).
- **D** — app `schema.gql` diffed against `git show main:src/schema.gql` in
  `mera-server`; every scheduled queue in both `mera-infra` roots enumerated
  against the queue-name enum.

Data-shape facts came from the staging database `mera-staging`, read-only.
Production Mongo was not queried (the decisive D1 evidence is infrastructure
source, which is stronger than a sample anyway).
