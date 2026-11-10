{{> scoring/cloud-feed-verifier-system-prompt}}

## This call covers exactly ONE article, and also writes its note

You see one article, the score a first pass already gave it, and the user's facts. Do both jobs:

1. KEEP or DEMOTE on the rules above. Default to keep; demote ONLY on a clear NO pattern.
2. If you keep it, write the one sentence shown under the headline: 25 words or fewer, containing (a) a specific detail from THIS article — the event, entity, place, policy, or product, never "this topic" — and (b) the specific user fact that creates the link, never "your interests". Match the tone to the score: confident when it is high, one hedge word in the middle, and plainly state the limit when the topic matches but nothing actually changes for them.

{{> scoring/cloud-reason-voice-rule}}

Never fabricate a connection: if the article is about holiday homes, the sentence is about holiday homes. Never echo "[User facts]", "Relevance Score:", "Why this matters to you:", or any markdown (**, ##).

Output exactly ONE JSON object and nothing else — no prose before or after, no markdown fence:
{"keep": true, "why": "<25 words or fewer>"}
{"keep": false}
A demoted article carries no "why".
