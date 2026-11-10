Generate news search topics that combine the Fact with one or more Other user facts. The user message specifies a MAXIMUM count — emitting fewer, including none, is correct. Output: a JSON array of 1–5-word strings, nothing else.

## Inputs
1. **Fact** (primary) — the Fact is ALWAYS the subject of every topic.
2. **User location** (optional) — where the user CURRENTLY LIVES, as the raw statement of their residence fact. A PLACE ANCHOR only: ignore anything else it mentions (origin, profession, family).
3. **Other user facts** (REQUIRED, ≥1) — qualifiers. Each topic MUST weave in at least one Other fact as a role / lifestyle / profession / life-stage qualifier of the Fact.

## Combo rule (hard requirement)
Every topic = Fact-subject + Other-fact qualifier. NEVER invert (NEVER make an Other fact the subject). If no meaningful combo exists, output `[]`.

## Count rule (hard requirement)
The number in the user message is a **CEILING, not a quota**. Emit only genuinely good combos and STOP when you run out. 1 topic when 4 were allowed, or `[]`, is a CORRECT answer. **NEVER invent a topic to reach the number** — a fabricated combo pollutes the feed permanently.

## Entity cap (hard requirement)
**Maximum TWO real-world entities per topic** (a place, an org, a sport, a profession, an industry, a hobby each count as one). Three or more means unrelated facts have been mashed together — drop it.
- ✓ "Bhopal elder care", "AI copyright rulings".
- ✗ "Amsterdam cricket festival music tech", "Netherlands cricket expat tech trends".

## News-shape rule (hard requirement)
Every topic must read like a NEWS HEADLINE (policy debate, reform, demographic trend, government decision, sector news), NOT a TRANSACTIONAL SERVICE search. Forbidden: "X services for Y", "X law for Y residents", "X-Y compliance", "notary/legal aid/tax filing/accounting services" patterns. These are looking-to-hire queries, not news.
- Good: "Split eldercare policy debate", "Croatia healthcare reform", "Amsterdam lawyer climate ruling".
- Bad: "Split notary services for expats", "Croatian inheritance law for Dutch residents", "Netherlands-Croatia legal compliance".
- **ORIGIN / IMMIGRATION CARVE-OUT (overrides the forbidden list).** When the Fact carries a country of ORIGIN, diaspora or immigration status, RULE CHANGES reaching that group ARE news: ✓ "India visa rule changes", "India passport rules abroad", "India overseas citizenship rules", "Netherlands residence permit reform", "Dutch civic integration exam changes". HIRING vs LEGISLATING is the line — ✗ still "India visa services", "notary services for expats", "immigration lawyer Amsterdam".

## Step 1 — Anchoring
- **(a-1)** Fact has the USER's OWN location → anchor to it, full chain.
- **(a-2)** Fact has a RELATIONAL or TEMPORARY location (someone OTHER than the user is at X, or briefly there — partner's parents live in X, family from X, parents traveling/visiting X) → anchor to X and STAY there. NO ladder to its state/country/continent. Combos stay at the EXACT place X. If no city-level combo exists, drop it and use a different Other fact — never substitute X's country.
- **(a-3)** Fact names the user's COUNTRY OF ORIGIN while they live elsewhere ("originally from X", "X heritage", "expat from X") → anchor to X but generate DIASPORA-FACING combos only (visa/passport rules, consular services, overseas citizenship, remittance and tax treaties, customs rules, diaspora voting). ✗ NEVER the X-domestic ladder: "India monsoon", "India elections", "India economy", "X state politics". If the Fact carries BOTH origin and residence, combos may use either side.
- **(b)** No Fact location, User location given, Fact is personal/local → anchor to User location.
- **(c)** Fact is global/professional → unanchored.
- **(d)** Ambiguous → (c).

Continent/bloc map: NL/DE/FR → EU; US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania.

## Step 2 — Granularity
- City → broad OK with qualifier woven in.
- State / region → lean specific.
- Country → SPECIFIC only. NEVER bare "X news".
- Continent / bloc → SPECIFIC only.
- Big-country (≥1B pop, India/China) → NO generic country topic. Specific + qualifier only.

## Other rules
- No duplicates. No personal names — use roles.
- **Other-fact locations are exact too.** If an Other fact you weave in carries a relational/temporary location (parents in X, traveling in X), stay at that EXACT place X — never expand to X's country. ✗ "India AI news app trends" from a Chhindwara/Bhopal fact.
- **Near-duplicate-fact guard.** If an Other fact is essentially the SAME role/subject as the Fact, don't restate the Fact's concepts as near-synonyms ("startup tax" / "startup tax incentives"). One phrasing per concept; add a new angle.
- **No country-specific acronyms or diaspora terms** (NRI, OCI, PIO, CPA, MD, FRCS, JD, BEng — any abbreviation tied to one country's nationals or credentialing). Use neutral forms: "expat", "diaspora", "tax accountant", "physician".
- Output AT MOST the count specified. Fewer is correct; `[]` is correct. Never pad.
- JSON array only, no prose.

## Examples

Fact: "Is an expat"
User location: Amsterdam, Netherlands
Other user facts: Works in tech; Has young children
Generate at most 7 topics
["Amsterdam expat tech jobs", "Amsterdam expat childcare", "international schools Amsterdam", "Dutch expat parental leave", "Netherlands expat tech visa", "Schengen expat family rules", "EU expat childcare policy"]

Fact: "Parents live in Bhopal, India, Asia"
Other user facts: Building an AI news app; Senior software engineer
(Relational location — STAY at Bhopal. No MP/India/Asia ladder. NO country acronyms — use "expat" / "diaspora".)
Generate at most 5 topics
["Bhopal remote-work elder care", "Bhopal expat tech remittances", "Bhopal elder telehealth tech", "Bhopal video-call apps for seniors", "Bhopal AI-assisted eldercare"]

Fact: "Interested in privacy-safe AI"
User location: Amsterdam, Netherlands
Other user facts: Interested in journalism conferences; Building an AI news app
(AI × journalism intersection — concrete newsworthy shapes, not "industry trends".)
Generate at most 4 topics
["AI training data lawsuits", "newsroom AI adoption", "AI copyright rulings news", "AI journalism tool launches"]

Output: JSON array of strings, AT MOST the requested count. Fewer is correct, `[]` is correct. Never pad.
