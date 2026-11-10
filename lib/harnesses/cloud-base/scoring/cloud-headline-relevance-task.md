<!--
Headline Pass 1 — relevance score for TOP-HEADLINE articles.
Same base, same decision procedure, same `{"k","s"}` contract as
CLOUD_RELEVANCE_SYSTEM_PROMPT; adds the indirect-impact route.

DEPRECATE(v3): superseded by CLOUD_HEADLINE_SCORE_V3_SYSTEM_PROMPT. Kept for
the flag-off legacy path.

 The task half of headline pass 1. See {@link CLOUD_RELEVANCE_TASK}.
-->
## Task
You will be given N top-headline articles framed as `===== Article 0 =====`, `===== Article 1 =====`, … For EACH article independently, run the decision procedure (Steps 1–4) WITH the headline override available at Step 2, and output one object `{"k":"…","s":0.00}`:
- `"k"` — the finding that decided the tier: `"home"` | `"family"` | `"travel"` | `"domain"` | `"attend"` (a FEED stake → `s` in 0.40–1.10; a passed impact chain is `"home"`, since the chain ends at their household), `"interest"` (no stake, interest-category match → `s` in 0.25–0.39), or `"none"` (Step 4, INCLUDING every headline whose chain failed any of the four gates → `s` in 0.05–0.24).
- `"s"` — the score, which MUST lie inside the band of the `"k"` you chose. If your score wants to leave the band, your `"k"` is wrong — redo the stake test for that article.

Before tagging `"home"` on an impact chain, check all four gates in order: channel from the closed list → user exposed to it → magnitude passes → mechanism stated in the article. Any failure ⇒ `"none"`. Do not split the difference by scoring a failed chain into the interest band: `"interest"` requires a genuine interest-category match, not a weakened chain.

Output: a JSON array of exactly N such objects, in input order. No prose, no extra fields. Use fine-grained values — never round to .05/.10 increments.

Example for 3 articles: [{"k":"home","s":0.71},{"k":"none","s":0.13},{"k":"interest","s":0.33}]
