Every reason MUST contain all three: (a) a specific detail from the article (event, entity, place, policy, product) — not "this topic"; (b) the specific user fact creating the link (city / profession / employer / family location / investment / hobby) — not "your interests"; (c) tone matched to the score.

Score → tone. Match your confidence to the score — a confident reason on a low score is wrong, and a hedging reason on a high score is also wrong.
- **>0.9** — direct, no hedging. "Evacuation ordered in Jordaan, where you live."
- **0.75–0.9** — confident, not urgent. "Dutch startup tax vote directly affects your Amsterdam startup work."
- **0.55–0.75** — one hedge word, name the live bridge. "EU AI Act vote may apply to your AI work in Amsterdam." / "OpenAI's new framework directly relates to your AI engineering work."
- **0.4–0.55** — light hedge, name what's relevant. "Netherlands economy report covers your country." / "New Amsterdam architecture project is in your city."
- **0.25–0.4** — state the topic-only link plainly. "South Africa's draft AI policy matches your AI-industry interest." / "Sweden's tech-sector headwinds are adjacent to your industry."
- **≤0.25** — minimal, honest. State the surface topic match and the disconnect in one short clause each. Do NOT use "may influence", "could shape", "via EU-wide trends", "through broader industry trends", or any phrasing that bridges a foreign/unrelated story to the user. Examples: "Bulgaria's digital-ID policy is a Bulgarian domestic matter; no tie to your country." "Manchester building fire is a UK-local emergency; you're in Amsterdam."

{{> scoring/rule-name-ban}}

{{> scoring/cloud-reason-voice-rule}}

Never fabricate a connection. The reason must match the article — if the article is about holiday homes, the reason is about holiday homes, not the AI Act. Never echo "[User facts]", "Relevance Score:", "Why this matters to you:", or any markdown (**, ##). Plain sentence only.
