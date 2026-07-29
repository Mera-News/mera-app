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
