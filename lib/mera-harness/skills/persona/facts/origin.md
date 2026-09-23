---
id: facts/origin
name: "Origin facts"
description: "Extracts where the user is from, and where they live now when the turn says so, as separate facts."
routable: true
when:
  - "router chose new_fact or fact_update with subject origin"
  - "trigger phrases: originally from / I am from / grew up in / my heritage / expat / migrant / moved here from"
  - "signal: the turn names a country of origin, whether or not it also names where they live now"
outputs:
  - "one origin element under background: country of origin, plus a residence element only when the turn names where they live now"
  - "ask_choice, never prose, for an ambiguous place; a replacement is set with replaces and never asked first"
---

Where the user is FROM. Origin and current residence are two facts: where someone is from and
where they live now change on different days, and a move must never rewrite their origin.

## What to offer
- The origin: ONE element naming the country, or the region when they said it: "Expat from India",
  "Originally from Kerala, India". `questionnaire_attribute` is exactly `background: country of
  origin`.
- The current city, only when the turn names it: a SECOND element, written and looked up exactly
  as the residence guideline says, under the residence key `location: neighborhood/area, city, and
  country (preserve specifics)`. No city named: offer the origin alone and ask nothing about it.

Never write the two into one statement ("Expat from India living in Amsterdam"). Never offer
"Expatriate", "Lives outside country of origin" or any wording of that shape: it names no country
and retrieves nothing.

## Both lookups in one leg
Issue `lookup_place` and `find_similar_facts` in the same response. `lookup_place` takes
`{ query, countryHint? }` where `query` is the raw place words. `find_similar_facts` takes
`{ kind? }` and nothing else. Read the place result exactly as the residence guideline does: one
place proceeds, two or three go to `ask_choice`, and `bloc` is copied from what came back rather
than worked out.

When the turn names two places, the origin and the current city, look up the CURRENT one. The
origin country needs no chain: a country is the whole of it.

## Neutral words only
Write "expat", "diaspora", "overseas citizen", "moved from". Never a country-specific label or
acronym: not NRI, not OCI, not PIO, not DACA, not H-1B. Each is tied to one country's nationals and
narrows who the reader could be far more than the plain word does.

Do not add a nationality the user did not claim. "I grew up in Lagos" is where they grew up. It is
not a claim to Nigerian citizenship, and a fact that asserts one is wrong in a way they may never
see.

## Checking what is already known
Branch on the attribute key, never on the score.

- An existing origin fact, different country: set `replaces` to it. The card shows the user what
  it removes; do not ask first.
- An existing residence fact: never replace it with the origin. Replace it only with a residence
  element, and only when the turn names a different current city.
- An older fact under `background: origin and current residence`: leave it alone. Mera offers to
  split it on its own.
