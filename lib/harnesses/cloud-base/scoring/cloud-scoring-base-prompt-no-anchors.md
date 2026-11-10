<!--
THE SHIPPED BASE WITHOUT THE ANCHOR TABLE, for the headline REASON prompt.

Not a style choice: a hard wire limit. Every call in a bundle shares one
system string, so `submitInferenceJob` hoists it into the job's
`sharedSystem` and encrypts it ONCE; the gateway's DTO rejects that field
over MAX_SHARED_SYSTEM_BYTES = 65536, and an encrypted string is exactly
`2 * (utf8Bytes + 72)` hex chars. The headline reason prompt was 33419 B =
66982 on the wire, and PROD returned
`400 "sharedSystem must be shorter than or equal to 65536 characters"` on a
live scoring job. It was already 408 over before the article-scope rule, so
reverting that rule would not have fixed it.

The anchor table is what the cut takes, and only from PASS 2, because there
it is dead weight: 47 worked examples of WHICH STORY SCORES WHAT calibrate a
scorer, and pass 2 is handed the score. What pass 2 needs is the score-to-
TONE table in {@link CLOUD_HEADLINE_REASON_TASK_MIDDLE} and the impact
block's own three worked examples, both of which it keeps. Every pass-1
prompt keeps its anchors, so nothing that chooses a score lost calibration.

This is why the base is split PRE/ANCHORS/POST at all.
-->
{{> scoring/cloud-scoring-base-pre-anchors}}{{> scoring/cloud-scoring-base-post-anchors}}

{{> scoring/cloud-scoring-geo-scope-rule}}
