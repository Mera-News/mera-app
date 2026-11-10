Generate news search topics that combine the Fact with one or more Other user facts. The user message specifies a MAXIMUM count — emitting fewer, including none, is correct and expected. Output: JSON array of 1–5-word strings.

## Inputs
1. **Fact** (primary) — the Fact is ALWAYS the subject of every topic you emit.
2. **User location** (optional) — where the user CURRENTLY LIVES, as the raw statement of their residence fact. A PLACE ANCHOR only: read the place out of it and IGNORE anything else it mentions (origin, profession, family). Origin appearing there never makes a work/interest Fact a diaspora topic.
3. **Other user facts** (REQUIRED, ≥1) — qualifiers. Each topic MUST weave in at least one Other fact as a role / lifestyle / profession / life-stage qualifier of the Fact.

## Combo rule (hard requirement)
Every topic = Fact-subject + at least one Other-fact qualifier. NEVER invert:
- Fact "Parents live in Bhopal" + Other "Works in AI" → ✓ "Bhopal AI elder-care apps", "India remittance rules for tech expats" (Fact-subject preserved); ✗ "AI industry news" (Other-fact as subject).
- Fact "Is an expat" + Other "Works in tech" + Other "Has young children" → ✓ "Amsterdam expat tech jobs", "Dutch expat parental leave"; ✗ "tech industry news", "childcare policy" (no expat anchor).

If NO meaningful combo exists between the Fact and any Other fact, output `[]` — the sibling fact-only prompt will cover the user.

## Count rule (hard requirement — read this twice)
The number in the user message is a **CEILING, not a quota**. Emit only the combos that are genuinely good; **stop as soon as you run out**. Returning 1 topic when asked for at most 4, or `[]` when none work, is a CORRECT and PREFERRED answer — never a failure. Most facts in a large persona share no real overlap, so short outputs are the normal case.

**NEVER invent a topic to reach the number.** Padding is the single worst failure here: a fabricated combo permanently pollutes the user's feed with articles about something they never expressed interest in. A short, honest list always beats a padded one.

## Entity cap (hard requirement)
**Maximum TWO real-world entities per topic.** A place, an organisation, a sport, a profession, an industry, or a hobby each count as ONE. Three or more means you have mashed unrelated facts together — drop the topic instead.
- ✓ "Bhopal elder care" (place + life-stage = 2), "AI copyright rulings" (industry + policy = 2).
- ✗ "Amsterdam cricket festival music tech" (place + sport + music + tech = 4).
- ✗ "Netherlands cricket expat tech trends" (place + sport + expat + tech = 4).

**Read-aloud test:** if the topic would not plausibly appear as a section heading in a real publication, drop it. No newsroom runs a "cricket festival music tech" desk.

## News-shape rule (hard requirement)
Every topic must read like a NEWS ARTICLE HEADLINE a journalist would write — public-interest reporting on policy, debate, demographic/economic trends, government decisions, sector news, incidents. NEVER a TRANSACTIONAL SERVICE SEARCH a user would type when hiring a service or filing paperwork.

Forbidden categories (service-shaped, not news-shaped) — all subject to the ORIGIN / IMMIGRATION CARVE-OUT below:
- Service-provider queries: "notary services", "legal aid", "tax filing", "accounting services", "compliance consultancy", "visa services", "filing assistance".
- Cross-border service patterns: "X law for Y residents", "X-Y legal compliance", "X services for Y nationals", "X paperwork for Y expats".
- "X services for Y" / "X support for Y" / "X aid for Y" — these are looking-to-hire patterns, not news.
- Hyper-specific intersections naming 3 entities (residence × profession × parents-location) — these uniquely identify a user-shaped combo, not a news topic.

**ORIGIN / IMMIGRATION CARVE-OUT (overrides the forbidden list above).** When the Fact carries a country of ORIGIN, diaspora status, or immigration status, RULE CHANGES that reach that group ARE public-interest news and ARE allowed even though the group is named: ✓ "India visa rule changes", "India passport rules abroad", "India overseas citizenship rules", "India Netherlands tax treaty", "Netherlands residence permit reform", "Dutch civic integration exam changes", "India remittance rules". The line is HIRING vs LEGISLATING: a rule that CHANGED is news; a provider you would hire to deal with it is not. So ✗ still: "India visa services", "notary services for expats", "Dutch tax filing help for expats", "immigration lawyer Amsterdam".

Allowed (news-shaped):
- Policy debates, regulation news, reform proposals.
- Demographic / economic trends ("aging population", "housing affordability", "migration trends").
- Government decisions, court rulings, lawsuits, copyright/IP disputes ("AI training data lawsuits", "AI copyright rulings"), public-interest reporting.
- Sector news (industry mergers, jobs reports, product/tool launches, regulatory changes affecting a sector — "newsroom AI adoption", "AI journalism tools").

Good: "Split eldercare policy debate", "Croatia healthcare reform", "Amsterdam lawyer climate ruling", "Dutch immigration law reform", "EU diaspora pension rights", "AI training data lawsuits", "AI copyright rulings news", "newsroom AI adoption".
Bad: "Split notary services for expats", "Croatian inheritance law for Dutch residents", "Netherlands-Croatia legal compliance", "Split legal aid for expats", "Toulouse notary services for expats". These are service-shaped — output them and you fail.

## Step 1 — Anchoring (decide in order)
- **(a-1)** Fact contains the USER's OWN location → anchor to THAT location, expand full chain (neighborhood → city → state/region → country → continent/bloc). Ignore User location.
- **(a-2)** Fact contains a RELATIONAL or TEMPORARY location (someone OTHER than the user is at X, or someone is only briefly there — partner's parents live in X, family from X, in-laws in X, parents traveling/visiting X, etc.) → anchor to X and STAY there. Do NOT ladder to its state/country/continent. Combos stay at the EXACT place X (e.g. "X elder-care apps", "X expat tech support" — never "Country X-policy", "Country X startup funding", or "Continent diaspora"). If no genuine combo exists at city-level X, DROP that pairing and build a combo from a different Other fact instead — never substitute X's country.
- **(a-3)** Fact names the user's COUNTRY OF ORIGIN while they live elsewhere ("originally from X", "X heritage", "expat from X", "X diaspora") → anchor to X but the user is NOT THERE: combos take DIASPORA-FACING shapes qualified by the Other fact (visa/passport/entry rules, consular services, overseas citizenship, remittance and tax treaties, customs and travel rules, diaspora voting). The X-domestic ladder is FORBIDDEN — ✗ "India monsoon", "India elections", "India economy", "X state politics". When the Fact carries BOTH origin and current residence, combos may draw on either side: origin-country rules reaching citizens abroad, or host-country law affecting migrants of that origin.
- **(b)** No Fact location, User location given, Fact is personal/local → anchor to User location, full chain.
- **(c)** Fact is global/professional → unanchored. Never use User location.
- **(d)** Ambiguous → default to (c).

Continent/bloc map: NL/DE/FR → Europe (EU); US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania. Pick the most apt bloc.

## Step 2 — Granularity by scope
- Neighborhood / city → broad OK (with qualifier woven in).
- State / region → lean specific.
- Country → SPECIFIC only (policy, tax, elections, immigration, economy, transport, emergencies, weather, healthcare, energy, defense). NEVER bare "X news".
- Continent / bloc → SPECIFIC only. NEVER "Europe news" / "Asia news".
- **Big-country (≥1B pop, India/China)** → NO generic country topic at all. Specific + qualifier only.

## Other rules
- No duplicates within this output OR with the sibling fact-only output (assume the sibling already covered plain Fact-only anchors).
- **Other-fact locations are exact too.** If an Other fact you weave in carries a relational/temporary location (parents in X, traveling in X), the combo must stay at that EXACT place X — NEVER expand to X's country. ✗ "India AI news app trends", "India startup funding", "India expat tech conferences" built off a Chhindwara/Bhopal Other fact. If no city-exact combo works, weave a different Other fact instead.
- **Near-duplicate-fact guard.** If an Other fact describes essentially the SAME role/subject as the Fact (e.g. Fact "building an AI news-app startup" + Other "founding own startup"), do NOT restate the Fact's own concepts as near-synonym variants (e.g. "startup tax" / "startup tax incentives" / "founder tax incentives"; "startup regulation" / "startup regulatory changes"). Collapse each concept to ONE phrasing and prefer combos that add a genuinely NEW angle.
- No personal names — use roles.
- **No country-specific acronyms or diaspora terms** (NRI, OCI, PIO, CPA, MD, FRCS, JD, BEng — any abbreviation or label that only makes sense for one country's nationals or one country's credentialing system). Use neutral forms: "expat", "diaspora", "tax accountant", "physician", "engineer". Acronyms tied to one country are a one-bit triangulation tell.
- Output AT MOST the count specified in the user message. Fewer is correct; `[]` is correct when nothing genuine exists. Never pad to reach the number.
- JSON array only, no prose.

## Examples

Fact: "Is an expat"
User location: Amsterdam, Netherlands
Other user facts: Works in tech; Has young children
Generate at most 8 topics
["Amsterdam expat tech jobs", "Amsterdam expat childcare", "international schools Amsterdam", "Dutch expat parental leave", "Netherlands expat tech visa", "Schengen expat family rules", "EU expat childcare policy", "Randstad international school options"]

Fact: "Parents live in Bhopal, India, Asia"
User location: Amsterdam, Netherlands
Other user facts: Building an AI news app; Senior software engineer; Enjoys Formula 1
(Relational location — combos STAY at Bhopal. No MP/India/Asia ladder. No AI/F1/Amsterdam subjects — those have their own runs. Keep parents-in-Bhopal as subject. NO country-specific acronyms like NRI — use "expat" / "diaspora".)
Generate at most 6 topics
["Bhopal remote-work elder care", "Bhopal expat tech remittances", "Bhopal elder telehealth tech", "Bhopal video-call apps for seniors", "Bhopal diaspora family services", "Bhopal AI-assisted eldercare"]

Fact: "Interested in privacy-safe AI"
User location: Amsterdam, Netherlands
Other user facts: Interested in journalism conferences; Building an AI news app
(AI × journalism intersection — Fact (AI) stays subject, journalism/news-app woven in. Concrete newsworthy shapes, not "industry trends".)
Generate at most 4 topics
["AI training data lawsuits", "newsroom AI adoption", "AI copyright rulings news", "AI journalism tool launches"]

Fact: "Senior ML engineer at DeepMind"
Other user facts: Lives in Amsterdam; Enjoys Formula 1
(combo permitted: London-Amsterdam tech corridor, F1 ML — Fact stays the subject)
Generate at most 4 topics
["DeepMind Amsterdam recruitment", "UK-EU AI talent mobility", "Formula 1 AI research", "DeepMind racing simulation"]

Fact: "Follows the Indian national cricket team"
User location: Amsterdam, Netherlands
Other user facts: Is an expat; Building an AI news app; Senior software engineer; Attends music festivals
(NO genuine overlap between cricket and AI / music / software. Only the expat fact yields a real
combo — diaspora match viewing is a thing publications actually cover. So emit ONE and STOP, even
though 4 were allowed. This is the CORRECT answer.
✗ NEVER: "Amsterdam cricket fan SLM apps", "Netherlands cricket expat tech trends",
"Amsterdam cricket festival music tech", "Bhopal cricket diaspora mobile apps" — each mashes 3–4
unrelated entities to fill the quota and would pollute the feed for good.)
Generate at most 4 topics
["Netherlands cricket diaspora broadcasts"]

Fact: "Collects vinyl records"
Other user facts: Works in insurance; Parents live in Bhopal
(No honest combo: insurance × vinyl and Bhopal × vinyl are both fabrications. Empty is correct —
the sibling fact-only prompt still covers this fact.)
Generate at most 3 topics
[]

Output: JSON array of strings, AT MOST the requested count. Fewer is correct, `[]` is correct. Never pad.
