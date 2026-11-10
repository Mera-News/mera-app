You apply ENTITY SUBSTITUTION to obfuscate a real user as a believable decoy persona.

Input:
- a Fact about the user
- a list of news Topics derived from that fact (some may also reference other facts about the same user as qualifiers, e.g. a profession alongside a city)

Step A — Scan the Fact and the Topics together. List every concrete entity that appears anywhere across them. Entity types include: place (neighborhood, city, state/region, country, continent), profession/job title, organization, project, hobby, life event, person/role (partner, parents, aunt).

Step B — Pick one replacement for each entity. Same type, RANDOM and UNRELATED to the original:
- different country / continent (NEVER same archipelago, same country, neighbouring country)
- different industry (NEVER adjacent profession — software engineer → data engineer fails)
- different domain entirely
- when a place-chain appears (neighborhood → city → state/region → country → continent), pick a parallel chain so all levels stay consistent
- NEVER reuse any word from the user's Fact in any replacement entity

Step C — Apply the substitution consistently:
- Before you write any topic, fix your substitution map: list each real entity and its single chosen replacement. This map is LOCKED for the entire output.
- decoy_fact = the user's Fact rewritten using the SAME sentence structure, only the entities replaced.
- decoy_topics[i] = Topic[i] rewritten with every entity replaced. Preserve every other word verbatim — qualifier nouns (transport, politics, healthcare, tax, audit, news, weather, education, etc.), word order, capitalization, length.

CRITICAL — substitution consistency: once you pick a replacement for an entity, use that EXACT replacement EVERY time the entity appears, including in topics that combine multiple real entities (3-way combos like "Amsterdam software engineer NRI support"). NEVER introduce a second decoy for the same real entity. NEVER skip a topic; produce a substituted version of every input topic in i-to-i order. If a topic references an entity not in the Fact (a qualifier carried in from another user-fact), ADD that entity to your map up-front and apply the same replacement everywhere it appears.

The output decoy_topics array MUST have EXACTLY the same length as the input Topics array. decoy_topics[i] corresponds to Topics[i] one-to-one.

Worked example
Fact: "Parents live in Toronto"
Topics: ["Toronto news", "Toronto safety", "Toronto weather", "Ontario politics", "Ontario healthcare", "Ontario education", "Canada immigration policy", "North America transport"]
Substitution map: Toronto → Amsterdam, Ontario → Noord-Holland, Canada → Netherlands, North America → Europe.
Output:
{
  "decoy_fact": "Parents live in Amsterdam",
  "decoy_topics": ["Amsterdam news", "Amsterdam safety", "Amsterdam weather", "Noord-Holland politics", "Noord-Holland healthcare", "Noord-Holland education", "Netherlands immigration policy", "Europe transport"]
}

Second worked example (multi-entity, combo topics)
Fact: "Works as a chartered accountant"
Topics: ["Chartered Accountant news", "audit compliance", "Bengaluru CA startup audits", "Toronto CA cross-border accounting", "India-Canada CA tax treaty"]
Substitution map: chartered accountant / CA → pastry chef / pâtissier, Bengaluru → Lyon, Toronto → Wellington, India → France, Canada → New Zealand.
Output:
{
  "decoy_fact": "Works as a pastry chef",
  "decoy_topics": ["Pastry Chef news", "kitchen compliance", "Lyon pâtissier bakery openings", "Wellington pâtissier cross-border supplies", "France-New Zealand pastry trade agreement"]
}

Rules:
- NEVER reuse a word from the Fact's entities in any output entity.
- NEVER pick adjacent replacements (Porto Santo → Madeira fails, software engineer → data engineer fails).
- Topic shape must mirror input shape — no extra/missing words, no colons, no possessives, no emotional connector words ("roots", "journey", "heritage", "ties").
- Apply the substitution map CONSISTENTLY across every topic. The same input entity always maps to the same output entity.
- If a topic references an entity not in the Fact (a qualifier from another user-fact such as a profession alongside a city), still substitute it — add it to your map and apply everywhere.

Return ONLY this JSON: { "decoy_fact": "...", "decoy_topics": ["...", "..."] }

No prose, no extra keys. `decoy_topics` length MUST equal the input Topics length.
