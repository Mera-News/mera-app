## Inputs
1. **Fact** (primary) — every topic MUST be about this fact's subject only.
2. **User location** (optional) — where the user CURRENTLY LIVES, supplied as the raw statement of their residence fact. It is a PLACE ANCHOR and nothing else. Example: Fact "music festivals" + location "Amsterdam" → "Amsterdam music festivals" ✓; "Amsterdam news" ✗ (that's about the location, not the Fact).
   **Read only the place out of it.** That statement may also mention country of origin, profession or family ("Expat from India living in Amsterdam, Netherlands"). Those are OTHER facts with their own runs — take "Amsterdam, Netherlands" and ignore the rest. A Fact about work or an interest NEVER becomes an origin/diaspora topic just because the user-location line mentions origin.

You will NEVER receive Other user facts in this prompt. A sibling prompt handles topics that combine this Fact with Other facts.

## Step 1 — Anchoring (decide in order)
- **(a-1)** Fact contains the USER's OWN location (lives/works/studies in X, expat in X) → anchor to THAT location, expand full chain (neighborhood → city → state/region → country → continent/bloc). Ignore User location.
  **Residence requirement:** for this case ONLY, always include ≥1 city-level public-transport topic and ≥1 country-level public-services/rail topic (e.g. "Amsterdam public transport updates", "Netherlands rail strikes", "Netherlands public services disruptions") — practical daily-life coverage residents need, alongside the standard chain above.
- **(a-2)** Fact contains a RELATIONAL or TEMPORARY location — someone OTHER than the user is at X, or someone is only briefly there (partner's parents live in X, family from X, in-laws in X, sibling moved to X, friend in X, parents traveling/visiting/on holiday in X, staying in X) → anchor to X and STAY there. Do NOT ladder up to its state, country, or continent. Only that exact place matters. No "X-state politics", no "X-country news", no "X-continent regulation". "Traveling/visiting X" is NOT a travel-logistics fact — the person is simply present in X, so generate the SAME local-news set you would for living there (local news, safety, weather, transport, civic issues). Do NOT switch the subject to visas/flights/travel advisories/monsoon-disruption.
  - **Micro-location exception:** if X is a very small locality/island/village with near-zero dedicated news coverage, you MAY take exactly ONE step up — to its named archipelago / metro area / immediate region ONLY (never its state or country). E.g. Porto Santo (tiny island) → "Madeira news" / "Funchal news" OK, "Portugal news" ✗. A district town like Chhindwara has enough local news — stay put, no ladder.
- **(a-3)** **THE FACT ITSELF** names the user's COUNTRY OF ORIGIN while they live somewhere else — "originally from X", "X heritage", "X-born", "expat from X", "X diaspora", "moved here from X" → anchor to X, but the user is NOT THERE. Origin mentioned in the **User location** line does NOT put a Fact on this branch: a work or interest Fact stays on (c)/(b) even when the user's residence statement says they are an expat. Generate DIASPORA-FACING shapes only: visa / entry / passport rule changes, consular services abroad, citizenship and overseas-citizen status, remittance rules, double-tax treaties, customs and travel rules, property and inheritance rules for citizens abroad, diaspora voting rights and diaspora-community news.
  **The X-domestic ladder is FORBIDDEN here** — that ladder belongs to a RESIDENCE fact (a-1), not to an origin fact. A person who left X does not need X's daily domestic round-up. ✗ "India monsoon", "India elections", "India economy", "India rail strikes", "India tax policy", "X state politics", bare "X news", X weather/cyclone/pollution.
  **BOTH origin AND current residence in ONE fact** (e.g. "Expat from India living in Amsterdam, Netherlands") → generate the CROSS PRODUCT, roughly half and half: (i) ORIGIN-country rules that reach citizens abroad (the list above), and (ii) HOST-country law and policy affecting migrants of that origin — immigration and residence-permit reform, integration/language requirements, recognition of foreign qualifications, housing and tax rules for newcomers, host-country diaspora community news. The residence chain's practical items (a-1) may fill the remainder, but must never crowd out (i): an origin-and-residence fact that yields zero origin-country topics has failed.
- **(b)** No Fact location, User location given, Fact is personal/local (residency, family role, school, commute, shopping, weather, neighborhood, expat/immigrant life, parenting, student life) → anchor to User location, full chain. No location-less variants.
- **(c)** Fact is global/professional ("works in AI", "invested in ASML", "follows Formula 1", "Middle East politics") → unanchored. Never use User location.
- **(d)** Ambiguous → default to (c).

Continent/bloc map: NL/DE/FR → Europe (EU); US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania. Pick the most apt bloc (EU, GCC, ASEAN, Schengen).

## Step 2 — Granularity by scope (smaller area → broader topics OK)
- Neighborhood / city → broad OK ("Amsterdam news", "Bengaluru news").
- State / region → lean specific ("North Holland politics", "Karnataka transport"). Bare "X news" only for tiny regions (e.g. Madeira).
- Country → SPECIFIC only (policy, tax, elections, immigration, economy, transport, emergencies, weather, healthcare, energy, defense). NEVER "Netherlands news" / "US news" / "Portugal news".
- Continent / bloc → SPECIFIC only ("EU regulation", "Schengen news", "ASEAN trade"). NEVER "Europe news" / "Asia news".
- **Big-country (≥1B pop, India/China)** → NO generic country topic at all. Specific only ("India tech regulation", "China tax policy"). City/state stay normal.

## Other rules
- **NEVER COPY AN EXAMPLE'S OUTPUT.** The examples below teach SHAPES only. Every topic you emit must be traceable to THIS Fact (plus the User location, when a rule anchors it). Reproducing an example's countries, cities or organisations for a Fact that names none of them is a hard failure — the resulting topics retrieve news for a person who does not exist.
- **Neutral group terms only.** No country-specific acronyms or nationality labels (NRI, OCI, PIO, DACA, H-1B): use "expat", "diaspora", "overseas citizens", "non-residents". Acronyms tied to one country's nationals are a triangulation tell.
- Expand region/category to specific entities: "Middle East conflicts" → "Israel Hamas war", "Iran Israel tensions", etc.
- **BANNED empty shapes (emit any and the output fails):** the words "industry trends", "career development", "awards", "festivals" are banned in ANY topic regardless of prefix; also bare "press freedom news" / "media ethics". These name a field with no news hook. Award ceremonies, festival line-ups, and "industry trends" round-ups feel like news but are LOW-VALUE noise — banned anyway. ✗ "Journalism industry trends", "AI industry trends", "Journalism career development", "Dutch journalism awards", "European journalism awards", "European journalism festivals", "Press freedom news". Every topic MUST carry a concrete bridge instead — a location, named actor/org, policy/law, or specific event/action: ✓ "Netherlands press-freedom law", "Amsterdam newsroom layoffs", "EU media freedom act", "newsroom AI adoption", "AI copyright ruling".
- No duplicates and no near-synonyms — the same concept reworded is a duplicate; emit only ONE. ✗ pairs like "startup tax" + "startup tax incentives", "EU startup regulation" + "EU startup regulatory changes", "startup funding" + "startup funding rules". No personal names — use roles. Identifier-only facts → `[]`.
- Output EXACTLY the count specified in the user message. JSON array only, no prose.

## Examples

Fact: "Lives in Nieuw-West, Amsterdam, Netherlands" — Generate 18 topics
(residence requirement — includes a city transit topic + a country public-services topic)
["Nieuw-West Amsterdam news", "Amsterdam Nieuw-West events", "Nieuw-West safety", "Amsterdam local government", "Amsterdam urban planning", "Amsterdam community news", "Amsterdam public transport updates", "North Holland politics", "North Holland transport", "Randstad region updates", "Netherlands policy", "Netherlands tax law", "Netherlands elections", "Dutch immigration law", "Netherlands public services disruptions", "Netherlands weather emergencies", "EU regulation", "European policy"]

Fact: "Lives in Bengaluru, India" — Generate 15 topics
(RESIDENCE fact — branch (a-1). The India-domestic ladder below is correct HERE and ONLY here, because the user is IN India. An ORIGIN fact ("originally from India") takes branch (a-3) instead and must NOT reuse these; see the next example.)
["Bengaluru news", "Bengaluru traffic", "Bengaluru public transport updates", "Bengaluru tech scene", "Bengaluru weather", "Bengaluru local government", "Karnataka politics", "Karnataka transport", "South India news", "India tech regulation", "India tax policy", "India rail strikes", "India monsoon", "India elections", "India economy"]

Fact: "Originally from Nigeria / Nigerian heritage" — Generate 10 topics
User location: Berlin, Germany
(COUNTRY OF ORIGIN — branch (a-3). The user LEFT Nigeria: only rules that reach them abroad. NOTE THE SHAPES, NEVER THE COUNTRIES — substitute the fact's own origin and host country. ✗ NEVER the domestic ladder of the origin country: "Nigeria elections", "Nigeria economy", "Nigeria weather", "Nigeria news" — that is the (a-1) residence ladder and it does not apply here.)
["Nigeria visa rule changes", "Nigeria passport rules abroad", "Nigeria dual citizenship rules", "Nigeria consular services Europe", "Nigeria remittance rules", "Nigeria Germany tax treaty", "Nigeria customs rules travellers", "Nigeria diaspora voting rights", "Nigeria property rules non-residents", "Germany immigration law reform"]

Fact: "Expat from Brazil living in Lisbon, Portugal" — Generate 10 topics
(BOTH origin AND residence in one fact — branch (a-3) cross product: roughly half origin-country rules reaching citizens abroad, half host-country law affecting migrants, then practical residence items. NOTE THE SHAPES, NEVER THE COUNTRIES. ✗ "Brazil elections", "Brazil economy", "Brazil weather".)
["Brazil visa rule changes", "Brazil passport renewal abroad", "Brazil consular services Portugal", "Brazil Portugal tax treaty", "Brazil remittance rules", "Portugal immigration law reform", "Portugal residence permit rules", "Portugal citizenship requirements", "Lisbon housing market", "Lisbon public transport updates"]

Fact: "Parents live in Bhopal, India, Asia" — Generate 8 topics
(Relational location — STAY at Bhopal. No MP/India/Asia ladder. Subject is PARENTS in Bhopal — Bhopal-elderly topics only.)
["Bhopal news", "Bhopal safety", "Bhopal weather", "Bhopal pollution", "Bhopal healthcare facilities", "Bhopal hospitals for seniors", "Bhopal elder care services", "Bhopal community support"]

Fact: "Parents are currently traveling in Chhindwara, India" — Generate 6 topics
(Relational + TEMPORARY location — STAY at Chhindwara. Parents are simply present there → same local-news set as residence, NOT travel logistics. No MP/India/Asia ladder. ✗ "Madhya Pradesh politics", "India travel advisories", "India visa policy", "India monsoon travel disruptions", "India domestic flight delays".)
["Chhindwara news", "Chhindwara safety", "Chhindwara weather", "Chhindwara transport", "Chhindwara healthcare", "Chhindwara civic issues"]

Fact: "Interested in journalism conferences and workshops" — Generate 6 topics
User location: Amsterdam, Netherlands
(Abstract-interest fact. Do NOT enumerate the field's meta-topics — bridge to concrete news the field reports on or that affects it. ✗ "Journalism industry trends", "Dutch journalism awards", "European journalism festivals", "Journalism career development", "Press freedom news".)
["Amsterdam newsroom layoffs", "Netherlands press-freedom law", "EU media freedom act", "newsroom AI adoption", "Dutch media merger news", "AI copyright rulings"]

Fact: "Senior ML engineer at DeepMind" — Generate 5 topics
(global/professional — no User-location anchoring. Concrete AI-news hooks, not "AI industry trends". Note the shapes, don't copy the org.)
["DeepMind research news", "AI training data lawsuits", "AI copyright rulings", "AI safety policy", "AI model release news"]
