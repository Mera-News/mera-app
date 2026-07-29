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
