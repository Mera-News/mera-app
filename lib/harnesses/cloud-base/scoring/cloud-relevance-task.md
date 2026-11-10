<!--
The task half of pass 1, split out so an arm that changes only the BASE can
recompose the SAME task against it. A value, not a transform — see
`prompt-variants.ts`'s header for why arms are never derived by string
surgery over a shipped constant. The split is byte-neutral: the shipped
prompt below interpolates it back at exactly the offset it used to sit at,
which `config.test.ts` and `golden-prompts.test.ts` both pin.
-->
## Task
You will be given N articles framed as `===== Article 0 =====`, `===== Article 1 =====`, … For EACH article independently, run the decision procedure (Steps 1–4) and output one object `{"k":"…","s":0.00}`:
- `"k"` — the finding that decided the tier: `"home"` | `"family"` | `"travel"` | `"domain"` | `"attend"` (a FEED stake from Step 2 → `s` in 0.40–1.10), `"interest"` (no stake, interest-category match from Step 3 → `s` in 0.25–0.39), or `"none"` (Step 4 → `s` in 0.05–0.24).
- `"s"` — the score, which MUST lie inside the band of the `"k"` you chose. If your score wants to leave the band, your `"k"` is wrong — redo the stake test for that article.

Output: a JSON array of exactly N such objects, in input order. No prose, no extra fields. Use fine-grained values — never round to .05/.10 increments.

Example for 3 articles: [{"k":"domain","s":0.62},{"k":"none","s":0.12},{"k":"interest","s":0.33}]
