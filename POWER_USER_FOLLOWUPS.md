# Power-user follow-ups

Decisions where **the Mom won** — simplicity for the primary customer was chosen over control for
the power user. Each entry records what was simplified, what a power user lost, and the cheapest
way to give it back later. Nothing here is a bug; these are deliberate trades logged for review.

The standing preference: give control back **through chat first** (Mera can already mutate
everything via audited, revertible proposals), and only then through one more drill-in. Avoid
settings toggles — a toggle is the expensive answer, not the cheap one.

---

## Wave: structured "Not interested" filters (2026-07-29, `feature/not-interested-filters`)

### PU-1 · Manual filter creation is keyword-only
**Simplified:** the "Filter out a phrase" modal accepts a free-typed phrase and a soft/hard switch —
nothing else. Structured kinds (`category`, `event_type`, `entity`, `place`, `publication`, `topic`)
can only be *created* from a real article context: the feedback tree, the digest, or chat.
**Why:** structured kinds match by exact normalized equality. A free-typed `category` value that
doesn't exactly match the server's vocabulary would silently never fire — a filter that looks
active and does nothing is worse than no filter. There are no canonical vocabulary pickers to type
against.
**Power user loses:** the ability to hand-author a precise structured filter without finding an
article that exhibits it.
**Cheapest way back:** they already have it via chat ("Mera, never show me anything in the sports
category") — the agent supplies the value from real article context. A vocabulary-backed picker in
the AddPhrase modal is the expensive version; only build it if chat proves insufficient.

### PU-2 · Filter detail is hidden behind a row tap, inside a collapsed accordion
**Simplified:** the Not-interested screen opens with three collapsed section headers and counts.
Rows appear on expand; kind chip, strength, source, expiry and Remove appear on row tap.
**Why:** the flat alternative is a wall of rows with five metadata pills each — the exact cluttered
page the product philosophy rules out. Progressive disclosure keeps the surface Mom-shaped.
**Power user loses:** at-a-glance scanning of all filters and their strengths; no sort, no filter,
no bulk actions.
**Cheapest way back:** a single "expand all" affordance on the header, or persisting the expanded
state per section between visits. Both are small; neither was needed to ship.

### PU-3 · Publication mute is now a true exclusion, with no "strong downrank" middle setting
**Simplified:** a publication pref at `weight ≤ -0.9` synthesizes a hard filter — muted sources are
excluded outright rather than heavily penalized. The existing downrank tier (`-0.9 < w < 0`) still
behaves as a soft penalty.
**Why:** "mute" that still shows the source is a broken promise, and the previous heavy-penalty
behaviour was indistinguishable from a bug.
**Power user loses:** the old in-between — "almost never, but not never".
**Cheapest way back:** the downrank tier already covers most of it; if a finer scale is wanted, it
is a slider on the existing Source preferences row, not a new screen.

### PU-4 · A context-less thumbs-up/down is discarded rather than inferred from
**Simplified:** a bare thumbs tap leaves the button unfilled, changes nothing, and is discarded.
The persona only moves once the user says *why* (one tree tap, or chat).
**Why:** user's explicit direction. The previous behaviour silently aggregated bare verdicts into
topic-weight changes after two taps — the app speculating from a signal it can't interpret, with no
visible trace. The fill state is now a trust contract: filled means "this changed your persona".
**Power user loses:** the ability to train the feed by rapid-fire thumbing without ever opening the
reason tree.
**Cheapest way back:** if bare-verdict volume turns out to be high and the discard feels wasteful,
surface it as a batched question ("you disliked 6 stories about X — want fewer?") rather than
reinstating silent inference. That keeps the no-speculation contract intact.

### PU-5 · Feed reacts to persona changes on the next natural cycle, not instantly
**Simplified:** a persona change marks the feed dirty (the existing glow + hint on the Advanced
hub); the next foreground/sync cycle applies it. Hard filters are the exception — those purge
immediately, because "blocked" must mean blocked.
**Why:** user's explicit choice. An immediate rescore costs LLM calls per tap and is trivially
spammable.
**Power user loses:** instant feedback on how a weight change reshuffles the feed.
**Cheapest way back:** the Advanced-hub refresh button already forces it manually. A local
math-only re-rank (no LLM, milliseconds) would give instant reordering if this ever feels sluggish —
it was designed and deliberately not taken this wave.

### PU-6 · The inline Feed surface applies leaves silently; only the modal tree acknowledges nudges
**Simplified:** on the Feed's inline feedback surface, a leaf that carries persona actions applies
them with an Undo toast, but the two leaves that carry *no* action — "Subscribe to this
publication" and "Browse related coverage" — just close the surface, where the modal tree shows an
informational toast for them.
**Why:** wiring a toast host into the inline tree would have pulled the gluestack toast module into
the feed's hot import path for two advisory strings; the surface already gives a check + close as
acknowledgment.
**Power user loses:** the subscribe / browse-related hints on the Feed tab (they still appear from
the compact "…" sheet and the standalone-article actions row). The "a bare thumb is discarded"
caption itself is NOT part of this gap — it now renders identically on both surfaces.
**Cheapest way back:** route those two through the same `toastManager` the apply path now uses —
about ten lines, no new host.

### PU-7 · Only the thumbs-UP carries state on the actions row and compact sheet
**Simplified:** on `ArticleActionsRow` / `CompactActionsSheet`, a like shows none →
tinted → filled; a dislike is recorded and opens the tree but the button itself never looks
selected.
**Why:** those two surfaces record like and dislike independently (they are not mutually exclusive
there, unlike the Feed's verdict model), so a selected dislike needs its own restore-and-untoggle
story. Out of budget for a wave about making feedback mean something rather than look different.
**Power user loses:** at-a-glance "I already told Mera no about this" on non-Feed surfaces.
**Cheapest way back:** the state is already persisted and readable — `getArticleVerdict` returns
the dislike and its path; it is a rendering change plus an un-vote path.

### PU-8 · `wrong_place` stays hidden — no geo-mismatch derivation
**Simplified:** the feedback tree's "Wrong place" leaf is still gated out everywhere, because
nothing computes `hasGeoMismatch`. The *positive* side is now live: "More news from this place"
resolves against the article's real geo tags.
**Why:** the authoritative derivation (`scoring-engine/geo.resolveGeoMatch`) needs the full persona
location snapshot, the scoring config, and the anchored-location ids of the matched topic — none of
which the feedback surface has. Re-deriving it locally would be a second, quietly different answer
to "is this the wrong place", which is worse than not asking.
**Power user loses:** a one-tap "this is about the wrong city" on the dislike tree.
**Cheapest way back:** thread the scoring engine's already-computed `wrongLocationFlag` onto the
suggestion row at score time; the tree then reads it like any other gate.

### PU-9 · Plain persona chat can only mint KEYWORD filters
**Simplified:** in Mera chat (no article on screen), "stop showing me celebrity gossip" always
stages a keyword filter — a normalized substring match over title + description + entities. The
precise kinds (`category`, `entity`, `publication`, `place`, `topic`, `event_type`) are only
reachable from the chat opened on an article.
**Why:** every non-keyword kind matches by EXACT normalized equality against one article field, so
a value the model invents ("celebrity stuff" as a category) is a filter that silently never fires.
The article chat can corroborate a value verbatim against the `Category` / `Entities` /
`Publication` / `MATCHED TOPICS` lines it was given; plain chat has nothing to check against, so
the sanitizer drops `suppressionKind`/`suppressionValue` there rather than stage a dead filter.
**Power user loses:** "mute the whole Sport category" as a single sentence in generic chat — they
have to say it from any sports article instead (or say it as a phrase and accept a text match).
**Cheapest way back:** put the real vocabularies in front of the model — inject the distinct
`category` / `event_type` values actually present in the user's recent feed as a picklist in
`<context>`, then reuse the same corroboration set the article sanitizer already builds.

### PU-10 · `event_type` and `place` filters are never minted from an article either
**Simplified:** the article chat exposes the full `SUPPRESSION_KINDS` enum, but a value claimed for
`event_type` or `place` is downgraded to a keyword filter every time.
**Why:** `SuggestionFeedbackContext` carries `category`, `entities`, `publicationName` and the
matched topic texts — it carries no `eventType` and no `geoTags`. An uncheckable value gets the
same treatment as an invented one (D9), rather than a special exemption that would let exactly the
two unverifiable kinds through.
**Power user loses:** "never show me obituaries" / "nothing from Bavaria" as a precise filter from
an article; they get the keyword equivalent.
**Cheapest way back:** add `eventType` and `geoTags` to `SuggestionFeedbackContext` (the suggestion
row already has both) and to `CORROBORABLE_SUPPRESSION_KINDS` in
`lib/news-harness/article-feedback/agent-core.ts` — the sanitizer, prompt mapping and tests are
already shaped for it.

### PU-11 · The filter feature yields to a fact-heavy persona, and the list is capped
**Simplified:** the agents see at most 8 (article chat) / 10 (persona chat) of the user's active
filters. In persona chat the whole feature degrades under budget pressure, in this order: the
`YOUR FILTERS` block drops, then the tool documentation shrinks to a one-liner, then the filter
tools disappear for that turn. A user with 22 near-maximum-length facts gets no filter tooling in
Mera chat at all, and a user with 40 filters cannot ask "what have I hidden?" and get a complete
answer.
**Why:** the on-device input budget is 3072 tokens and the persona prompt already runs at ~3008 of
it at saturation, where `useLocalLLM` does not degrade — it hard-errors the turn with "Context too
long". The user's facts are the whole point of that prompt; our filter rules are the newest and
least essential thing in it, so they yield first. A turn where Mera cannot stage a filter proposal
is a far smaller failure than a dead turn.
**Power user loses:** conversational review of a long filter list, and removal-by-chat of a filter
that fell off the end.
**Cheapest way back:** a filters screen that lists all of them with a remove control — the removal
seam (`ACTION_NAMES.RETIRE_SUPPRESSION` via `applyPersonaAction`) is already audited and
revertible, so the screen is presentation only.

### PU-12 · Un-voting reverts the change the reason tree applied — including partially
**Simplified:** re-tapping a thumb clears the verdict, deletes its row, AND reverts whatever that
verdict's tree leaf applied to the persona. Same for a like↔dislike flip. If some of the revert
fails, the rest still goes through — un-voting is never blocked, and the shortfall is logged.
**Why:** shipped rather than deferred. Without it "unfilled" could also mean "this changed your
persona, and the change is still in force" — a new instance of the exact UI-says-one-thing problem
D15 exists to remove. `applyLeafActions` records the `changeLogIds` on the verdict row and
`removeArticleFeedback` — the single choke point every surface funnels through — reverts them.
**Power user loses:** the ability to keep a leaf's change while dropping the verdict that carried
it. There is no UI for that combination and no evidence anyone wants it.
**Cheapest way back:** the changes remain individually revertible from the Activity list, so a user
who wants the change back can re-apply it there; the leaf itself is one tap to re-pick.

### PU-13 · A structured filter shows its KIND, but not the exact value it matches on
**Simplified:** the chat confirm card renders a structured filter as a small kind chip
("Category", "Event type", …) above the human phrase the user or the agent used. The
`suppressionValue` — the exact field token the filter actually compares against — is not shown, and
when the two differ (chat can stage a pattern in the user's own words with a verbatim value copied
from the article) only the phrase appears.
**Why:** two strings on one row is the kind of clutter the card exists to avoid, and the chip
already carries the load-bearing difference — "this matches the category field" vs "this matches
text anywhere in a story". A user who wants the exact value can find it on the Not-interested
screen, where the detail already lives.
**Power user loses:** verifying at confirm time that the value the agent copied is the one they
meant, without going to another screen.
**Cheapest way back:** render the value as a second dim line only when it differs from the pattern —
two lines on the rare row rather than on every row.

### PU-14 · Only the feedback tree's own placeholders can mint a structured filter
**Simplified:** a tree leaf's `kind` is honoured only when its `pattern` is the context placeholder
that reads exactly that field (`from_context_category` + `kind: 'category'`,
`from_context_eventType` + `kind: 'event_type'`). A literal pattern with a kind, a mismatched pair,
or an unknown kind all degrade to a keyword filter.
**Why:** D9 — every non-keyword kind matches by exact normalized equality on one article field, so
a value that did not come verbatim from that field is a filter that looks active and fires never.
The placeholder is the only thing that proves provenance; trusting the leaf's `kind` alone would let
a future server-authored tree ship dead filters that nothing in the app could detect.
**Power user loses:** nothing today. A tree author loses the ability to hand-write, say, a
`publication` or `entity` filter into a leaf.
**Cheapest way back:** add the placeholder + accessor pair to `SUPPRESSION_SOURCES` in
`lib/news-harness/feedback-tree/resolve-leaf-actions.ts` — one line per new field, and the guard
keeps working. (Note the asymmetry with PU-10: the tree and the digest CAN mint `event_type`
because they read the article's own snapshotted field, while the article chat still cannot, because
its `SuggestionFeedbackContext` has no `eventType` to corroborate the model against.)

### PU-15 · The Not-interested screen shows "Shown less", never a number
**Simplified:** on the Not-interested screen a filter reads *Blocked* or *Shown less*, and a
negative topic reads *Shown less* or *Blocked* — nothing renders the underlying `strength` (0.5 /
0.8) or the topic `weight` (-0.6, -1.0). The plan called for a weight badge on the topic rows; it
became the same two-state badge the filter rows use.
**Why:** the north star is a reader who glances at this screen to undo something she told Mera in
chat. "-0.6" is internal vocabulary — it is only meaningful next to the scoring config, and putting
it on the row invites the question "what would -0.7 do?", which the screen cannot answer. The
two-state badge carries the only distinction that changes what she sees: excluded outright, or just
demoted.
**Power user loses:** the ability to see *how* negative a topic is, and therefore to notice that two
rows reading the same are actually a mild and a severe demotion.
**Cheapest way back:** the badge is one component; render the rounded percentage beside it behind a
single "show details" affordance, or add it to the tap-to-reveal detail block, which already exists
on both row types and is where every other piece of machinery went.

### PU-16 · One row open at a time, and one blended count on the hub
**Simplified:** expanding a filter row collapses whatever was open, and the Advanced-hub row reads
"N things you've hidden" — one number summing filters, negative topics and muted sources.
**Why:** a single open row keeps `not-interested-row-detail` unambiguous for the harness and keeps
the page short enough to take in at a glance; a single total is what someone asking "have I hidden
too much?" actually wants, and the three per-section counts are one tap away.
**Power user loses:** comparing two filters' provenance side by side, and seeing at the hub which
*kind* of thing has been accumulating.
**Cheapest way back:** hold a `Set` of open row ids instead of a single id (the state is already
per-id), and make the hub subtitle a "2 filters · 3 sources" join. Both are contained; neither was
needed to ship.

### PU-17 · "This category" is offered only on specialist sources
**Simplified:** "not important → this category" appears only when the article's category is
discriminating. On the generic "news" family — `News`, `general_news`, and every `News (French)` /
`News (English, Pidgin)` variant — the option is **absent from the tree**, not shown-and-inert and
not silently downgraded. It is present as normal on Sports / Tech / Business / `Regional News: <place>`
stories.
**Why:** the app's `category` is the PUBLICATION SOURCE's category, not the article's own. 2567 of
3475 prod sources (73.9%) and **32,046 of the 40,000 most recent articles (80.1%)** sit on that
generic family, so an exact match there means "most of the feed" rather than "this category" — from
a gesture the user believes is about one story, with no way to connect a flat feed to that tap 30
days later. The first cut degraded it to a keyword filter instead, which QA caught (F4): that
produced a filter row literally labelled "News" matching arbitrary stories that merely mention the
word — worse than the filter it was avoiding. A useless value earns nothing, and an option that can
do nothing should not be on screen.
**Power user loses:** any per-category control on general-news sources — most of them. "Never show
me this category" from a Reuters story is not offered at all; they can still use the phrase filter
or ask Mera in chat.
**Cheapest way back:** a real article-level category from the tagging pipeline (the same enrichment
that owes us `event_type`). The moment articles carry their own category, the gate in
`lib/news-harness/feedback-tree/category-specificity.ts` can be deleted and every category becomes
structurable — the re-check query is in that file's header.

### PU-18 · "This kind of event" is hidden rather than shown-and-dead
**Simplified:** the `this_kind_of_event` leaf is gated behind a new `has_event_type` visibleIf, so
it does not appear at all while the article carries no event type — which is every article today.
**Why:** the server populates `event_type` on 0 of ~303k articles, so the leaf rendered, resolved
to no actions, applied nothing and showed no toast. A dead option teaches the user that the
feedback doesn't work; a missing one costs nothing. The gate lifts itself the moment tagging starts
writing the field — no app release needed.
**Power user loses:** nothing they had — the option never did anything.
**Cheapest way back:** it returns automatically. Note the gate only reaches devices on the BUNDLED
tree; the server-hosted tree (`app-config.feedback_tree_v1`) needs the same `visibleIf` published to
take effect for everyone — see the wave report.

---

## Wave: prefer specific news sources (2026-07-29, `feature/not-interested-filters`)

### PU-19 · "Prefer" changes WHICH outlet fronts a story, never how high it ranks
**Simplified:** a source preference elects the representative of a multi-source story and lifts
preferred rows to the top of the detail page's related list. It does **not** move the story up the
feed, and there is deliberately no positive mirror of the hard-exclusion path — no "always show me
this source".
**Why:** the score term that would express it (`W_PUB = 0.076`) contributes ≈ +0.040 against a topic
match's +0.365, and is inert in prod anyway because every article takes the legacy LLM path and the
math score is discarded — so ranking-by-preference would have been a promise the pipeline cannot
keep. More fundamentally, you cannot force an irrelevant article into a relevance-ranked feed
without breaking the ranking that makes the feed worth reading. What the user actually asked for —
"those articles should be the ones used" — is the representative choice, and that is exact.
**Power user loses:** "show me more Times of India stories overall", as opposed to "when a story has
a ToI article, show me that one".
**Cheapest way back:** the honest version is a per-source multiplier applied where relevance is
already decided, not a thumb on `W_PUB`. That means the cloud judge would have to see the
preference, which costs prompt budget and, more importantly, is the first thing in this feature that
would leave the device.

### PU-20 · A group preference can only be a COUNTRY
**Simplified:** "more from Indian sources" is stored as one live scope row (`scope_kind='country'`,
`scope_value='IND'`) evaluated against each article's `country_code` at render time. There is no
`category` scope, no language scope, no "sources like this one".
**Why:** `country_code` is populated on 3464/3464 active publication sources, so the scope is sound.
`category` is not the article's category but the **publication's**, and 63% of sources share two
generic values — a "prefer tech sources" scope would quietly mean "prefer most of the feed", the
same trap PU-17 documents on the negative side. The rejected alternative — expanding "Indian
sources" into the ~308 publication rows that match today — goes stale the moment a feed is added,
floods the Source-preferences screen, and makes un-preferring a 308-row delete.
**Power user loses:** preferring a language, a region smaller than a country, or a subject specialism.
**Cheapest way back:** the storage is already a `scope_kind`/`scope_value` discriminator, so a second
kind is one enum value plus one branch in `sourcePriorityTier` and one in the context loader. A
LANGUAGE scope is the cheap next one — `language_code` is as well-populated as `country_code`.
Category has to wait for real article-level categories, exactly like PU-17.

### PU-21 · An uncorroborated publication name is DROPPED, not staged
**Simplified:** if the user asks to prefer a publication whose name does not appear in their own data
(`getTopVisitedPublications()` ∪ the distinct `publication_name`s in their cached suggestions), the
proposal is dropped and nothing is staged. Country scopes need no corroboration — they resolve
through a closed vocabulary (`i18n-iso-countries`), and an unresolvable country name is dropped too.
**Why:** this is the positive-case twin of the invariant PU-9/PU-14 establish. Preference matching is
exact normalized-name equality, so a model-invented "Times of India Group" would mint a row that
appears on the Source-preferences screen, reads as active, and can **never** fire. Unlike a filter,
there is no keyword fallback to degrade to — a preference either names a real publication or it does
nothing — so dropping is the only honest option.
**Power user loses:** preferring a publication they read elsewhere and have never seen in Mera. They
will be told nothing was staged rather than being shown a dead row.
**Cheapest way back:** corroborate against the server's publication list instead of the user's own
data. That is a new query and a new thing the server learns about the request, so it was not taken;
a cheaper half-step is to corroborate against the sources already visible in the current feed.

### PU-22 · The Dashboard fixes the fronting outlet but not the card's position
**Simplified:** on the Feed, D4 makes a story group carry its BEST member's score, so electing a
preferred source can never demote the story. On the Dashboard there is no mirror: card order is the
representative's `createdAt` descending, so a preferred source with an older `createdAt` still sinks
its own card.
**Why:** the two selectors share a byte-identical representative comparator, but the Dashboard has no
score to group-max — fixing the same latent demotion there means group-maxing `createdAtMs`, which
changes what "newest" means for every card, preference or not. That is a different semantic change
from the one this wave was authorized to make, and it would move card order for users who have
expressed no preference at all.
**Power user loses:** on the Dashboard only, a preferred source can pull its story down the section.
The story never disappears and the fronting outlet is still correct.
**Cheapest way back:** `groups.sort(cardCompare)` reading `Math.max(...group members' createdAtMs)`
instead of the representative's — one line, but it needs its own before/after on a real Dashboard
because it reorders cards for everyone.

### PU-23 · Teaching Mera about source preferences cost the filter list one rung of headroom
**Simplified:** the persona prompt's `FILTERS` prose now also documents `set_publication_pref` and
`set_source_scope_pref`, which costs **81 tokens** at the `full` rung (system prompt 1705 → 1786).
Worst-case measured prompt goes 2968 → **3049 of 3072**, so the headroom PU-11 relied on drops from
**104 tokens to 23**.
**Why it matters:** the ladder still fits at every rung and the ordering invariant holds, but the
threshold moved. A user at the saturation point PU-11 describes — 22 maximum-length facts *and* 10
active filters — now degrades one rung earlier than before this wave: they keep the filter *tools*
but lose the `YOUR FILTERS` context block, so Mera can still hide something for them but can no
longer read their filter list back. Nobody loses a turn; the `off` rung is still byte-identical to
the pre-P4a prompt.
**Mitigation already taken:** both new actions ride the `full` rung **only** — prose *and* JSON
schema. `compact` is byte-identical to before, so the rung that exists to rescue a budget-pressured
turn was not made more expensive. That was the deliberate trade: source preferences are also
reachable from the Source-preferences screen and from any article's feedback tree, whereas filters
are reachable from chat alone, so filters get the cheaper rung to themselves.
**Power user loses:** nothing they could not already lose at saturation — the boundary just sits 81
tokens earlier.
**Cheapest way back:** the `FILTERS` prose is the only channel that teaches the LOCAL path anything
(`schemaTypeToString` emits neither `enum` nor `description`), so the tokens cannot simply move into
the schema. The real fix is to stop paying for the CLOUD path's documentation on the LOCAL prompt —
they share one string today. Splitting them would return most of the 81 tokens, and more besides.

---

## Deferred defects (not trades — logged here for lack of a better home)

Unlike everything above, these are not "the Mom won" decisions. They are known-wrong behaviours
left alone deliberately because the honest fix is bigger than the symptom.

### DD-1 · A committed DISLIKE shows nothing on the standalone-card surfaces
**Where:** `components/custom/cards/ArticleActionsRow.tsx`, `components/custom/cards/CompactActionsSheet.tsx`.
**What's wrong:** both track only `likeState`; the dislike button is hardcoded `selected={false}`, so
a dislike that the user fully explained through the feedback tree renders identically to one they
never cast. The inverse of the F2/F3 defect the P4i wave fixed everywhere else — those surfaces were
immune to the branch-descent over-fill only because they show no dislike state at all.
**Why it wasn't fixed with the rest:** the missing state is not the whole gap. On these two surfaces
a dislike also has no un-vote — `handleDislike` unconditionally re-records and reopens the tree,
where `handleLike` toggles. Adding the filled treatment alone would produce a filled thumb the user
cannot clear by re-tapping, which is a worse dead end than the current silence. Doing it properly
means giving dislike the same record/flip/un-vote lifecycle as like, on a surface neither QA nor this
wave exercised.
**User loses:** no confirmation that a dislike given from a standalone card or a compact row was
recorded. The signal IS persisted correctly — this is display only.
**Cheapest way back:** hoist both surfaces onto the same `verdict + committed` pair the feed and
detail screens now use (`getArticleVerdict` already returns both), and give dislike the like path's
re-tap-to-un-vote. Roughly one focused pass over the two files plus a device check of the un-vote.
