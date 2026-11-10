{{> scoring/local-scoring-base-prompt}}

## Task
Score the article in `===== Article 0 =====` using Step 0 → Step 1 → anchors.

Output: a JSON array of 1 number, e.g. `[0.62]`. Use the FULL continuous range — never round to .05/.10. No prose, no keys — array only.
