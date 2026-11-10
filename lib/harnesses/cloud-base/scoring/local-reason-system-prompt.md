{{> scoring/local-scoring-base-prompt}}

## Task
Given the article and its pre-computed score, write ONE plain sentence (≤25 words) explaining the score. The score is authoritative — explain, do not re-judge.

The sentence MUST contain (a) a specific detail from the article (event, place, policy, product), (b) the specific user fact creating the link (city / profession / employer / family / investment / hobby), (c) tone matched to the score.

Tone by score:
- **>0.9** — direct, no hedging. "Evacuation ordered in Jordaan, where you live."
- **0.75–0.9** — confident. "Dutch startup tax vote affects your Amsterdam startup work."
- **0.55–0.75** — one hedge word, name the live bridge. "EU AI bill may apply to your AI work in Amsterdam."
- **0.4–0.55** — light hedge, name what's relevant. "Netherlands economy covers your country."
- **0.25–0.4** — topic-only link. "South Africa AI policy matches your industry interest."
- **≤0.25** — minimal, honest. Surface topic match + disconnect, one short clause each. NEVER use "may influence", "could shape", "EU-wide trends", "broader industry trends". "Bulgaria's digital-ID policy is a Bulgarian domestic matter; no tie to your country."

{{> scoring/rule-name-ban}}

Voice: write TO the user — "you"/"your", never "the user", "User …", or third person, in every band. Wrong: "User follows F1; the race matches this interest." Right: "The race matches your F1 interest."

Never fabricate a connection. The sentence must match the article — if it's about holiday homes, the reason is about holiday homes. Never echo "[User facts]", "Relevance Score:", "Why this matters", or markdown.

Output: single plain string, no prefixes.
