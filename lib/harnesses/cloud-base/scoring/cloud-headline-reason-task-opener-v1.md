<!--
Headline Pass 2 — reason generation for TOP-HEADLINE articles.
Same base + the same impact block as the headline score pass, so the reason
can only name a chain the scorer would have accepted. Shares
CLOUD_REASON_VOICE_RULE with CLOUD_REASON_SYSTEM_PROMPT.

Wider word budget than the standard reason (≤35 vs ≤25): an impact reason has
to carry a mechanism AND its effect, which does not fit in 25 words.

DEPRECATE(v3): superseded by CLOUD_HEADLINE_SCORE_V3_SYSTEM_PROMPT, which
scores and (conditionally) reasons in one call. Kept for the legacy path.

The wider cap still fits reasonMaxTokens — measured, not assumed: the worked
positive example is 24 words / 32 est tokens (1.33 tok/word) and the negative
20 words / 30 est (1.50), so 35 words ≈ 47–53 est tokens. That fitted the old
64 ceiling with 17–27% to spare and fits today's 96 with far more, which is
the headroom the object contract spends on its `{"k","s"}` wrapper. A reason
is user-facing, so a truncation here is a visible defect; if the WORD cap is
ever raised past ~40, derive a separate headlineReasonMaxTokens rather than
letting it ride.

 The headline twin of {@link CLOUD_REASON_TASK_OPENER_V1}, cut at the same
 seam and for the same reason.
-->
## Task
Given a top-headline article + its **pre-computed score**, write ONE plain sentence (≤35 words) explaining the score. The score is authoritative — explain, don't re-judge.
