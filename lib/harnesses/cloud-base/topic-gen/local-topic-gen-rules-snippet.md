## Inputs
1. **Fact** (primary) — every topic MUST be about this fact's subject only.
2. **User location** (optional) — where the user CURRENTLY LIVES, as the raw statement of their residence fact. A PLACE ANCHOR only: read the place out of it and IGNORE anything else it mentions (origin, profession, family) — those are other facts with their own runs.

You will NEVER receive Other user facts. A sibling prompt covers fact-combination topics.

## Step 1 — Anchoring (decide in order)
- **(a-1)** Fact contains the USER's OWN location (lives/works/studies in X) → anchor to THAT location, full chain (neighborhood → city → state/region → country → continent/bloc). Ignore User location. Residence requirement: always include ≥1 city public-transport topic and ≥1 country public-services/rail topic (e.g. "Amsterdam public transport updates", "Netherlands rail strikes").
- **(a-2)** Fact contains a RELATIONAL or TEMPORARY location (someone OTHER than the user is at X, or someone is only briefly there — partner's parents live in X, family from X, parents traveling/visiting X) → anchor to X and STAY there. Do NOT ladder to its state/country/continent. "Traveling/visiting X" = present in X, so generate the same local-news set as living there (local news, safety, weather, transport) — NOT visas/flights/travel advisories. Exception: if X is a tiny locality/island with almost no news, take at most ONE step to its named archipelago/region only (Porto Santo → "Madeira news" OK, "Portugal news" ✗).
- **(a-3)** **THE FACT ITSELF** names the user's COUNTRY OF ORIGIN while they live elsewhere ("originally from X", "X heritage", "X-born", "expat from X", "X diaspora") → anchor to X but generate DIASPORA-FACING shapes only. Origin in the User location line does NOT trigger this branch — a work/interest Fact stays on (c)/(b). Shapes: visa/entry/passport rule changes, consular services abroad, citizenship and overseas-citizen status, remittance rules, double-tax treaties, customs and travel rules, property/inheritance rules for citizens abroad, diaspora voting rights. **The X-domestic ladder is FORBIDDEN here** — it belongs to a RESIDENCE fact (a-1). ✗ "India monsoon", "India elections", "India economy", "India rail strikes", "X state politics", bare "X news", X weather. If the fact carries BOTH origin AND current residence ("Expat from India living in Amsterdam, Netherlands"), generate the CROSS PRODUCT — roughly half origin-country rules reaching citizens abroad, half host-country law affecting migrants (immigration/residence-permit reform, integration requirements, recognition of foreign qualifications) — then practical residence items.
- **(b)** No Fact location, User location given, Fact is personal/local (residency, family role, school, commute, shopping, weather, neighborhood, expat/immigrant life, parenting, student life) → anchor to User location, full chain. No location-less variants.
- **(c)** Fact is global/professional ("works in AI", "invested in ASML", "follows Formula 1", "Middle East politics") → unanchored. Never use User location.
- **(d)** Ambiguous → default to (c).

Continent/bloc map: NL/DE/FR → Europe (EU); US/CA/MX → North America; IN/JP/ID → Asia; BR/AR → South America; EG/NG → Africa; AU/NZ → Oceania. Pick the most apt bloc (EU, GCC, ASEAN, Schengen).

## Step 2 — Granularity by scope
- Neighborhood / city → broad OK ("Amsterdam news", "Bengaluru news").
- State / region → lean specific ("North Holland politics", "Karnataka transport"). Bare "X news" only for tiny regions (e.g. Madeira).
- Country → SPECIFIC only (policy, tax, elections, immigration, economy, transport, emergencies, weather, healthcare, energy, defense). NEVER "Netherlands news" / "US news" / "Portugal news".
- Continent / bloc → SPECIFIC only ("EU regulation", "Schengen news", "ASEAN trade"). NEVER "Europe news" / "Asia news".
- **Big-country exception (≥1B pop, India/China)** → NO generic country topic at all. Specific only ("India tech regulation", "China tax policy"). City/state stay normal.

## Other rules
- **NEVER COPY AN EXAMPLE'S OUTPUT.** The examples teach SHAPES only. Every topic must be traceable to THIS Fact (plus the User location where a rule anchors it). Emitting an example's countries or organisations for a Fact that names none of them is a hard failure.
- **Neutral group terms only** — no country-specific acronyms or nationality labels (NRI, OCI, PIO, H-1B). Use "expat", "diaspora", "overseas citizens", "non-residents".
- **BANNED empty shapes:** the words "industry trends", "career development", "awards", "festivals" are banned in ANY topic; also bare "press freedom news" / "media ethics". Award ceremonies and "industry trends" round-ups feel like news but are LOW-VALUE — banned anyway. ✗ "Journalism industry trends", "AI industry trends", "Dutch journalism awards", "European journalism awards". Each topic needs a concrete bridge (location, named actor, policy, or specific event) ✓ "Netherlands press-freedom law", "newsroom AI adoption", "EU media freedom act", "AI copyright ruling".
- No duplicates and no near-synonyms — emit only ONE per concept. ✗ "startup tax" + "startup tax incentives", "EU startup regulation" + "EU startup regulatory changes". No personal names — use roles. Identifier-only fact → `[]`.
- Output EXACTLY the count specified in the user message. JSON array only, no prose.

## Examples

Fact: "Lives in Nieuw-West, Amsterdam, Netherlands" — Generate 14 topics
["Nieuw-West Amsterdam news", "Amsterdam local government", "Amsterdam urban planning", "Amsterdam community news", "North Holland politics", "North Holland transport", "Randstad region updates", "Netherlands policy", "Netherlands tax law", "Netherlands elections", "Dutch immigration law", "Netherlands weather emergencies", "EU regulation", "European policy"]

Fact: "Lives in Bengaluru, India" — Generate 13 topics
(RESIDENCE fact — branch (a-1). The India-domestic ladder is correct HERE only, because the user IS in India. An ORIGIN fact takes (a-3) — see below.)
["Bengaluru news", "Bengaluru traffic", "Bengaluru tech scene", "Bengaluru weather", "Karnataka politics", "Karnataka transport", "South India news", "India tech regulation", "India tax policy", "India monsoon", "India elections", "India economy", "Asia economic news"]

Fact: "Expat from Brazil living in Lisbon, Portugal" — Generate 10 topics
(ORIGIN + RESIDENCE — branch (a-3) cross product. NOTE THE SHAPES, NEVER THE COUNTRIES. ✗ NEVER the origin country's domestic ladder: "Brazil elections", "Brazil economy", "Brazil weather".)
["Brazil visa rule changes", "Brazil passport renewal abroad", "Brazil consular services Portugal", "Brazil Portugal tax treaty", "Brazil remittance rules", "Portugal immigration law reform", "Portugal residence permit rules", "Portugal citizenship requirements", "Lisbon housing market", "Lisbon public transport updates"]

Fact: "Parents are currently traveling in Chhindwara, India" — Generate 6 topics
(Relational + TEMPORARY — STAY at Chhindwara, same local-news set as residence. No MP/India ladder, no travel advisories/visas.)
["Chhindwara news", "Chhindwara safety", "Chhindwara weather", "Chhindwara transport", "Chhindwara healthcare", "Chhindwara civic issues"]

Fact: "Senior ML engineer at DeepMind" — Generate 6 topics
(concrete AI-news hooks, not "AI industry trends"; note the shapes, don't copy the org)
["DeepMind research news", "AI training data lawsuits", "AI copyright rulings", "AI safety policy", "AI model release news", "AI startups"]
