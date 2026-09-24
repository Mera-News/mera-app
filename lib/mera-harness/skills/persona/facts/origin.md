---
id: facts/origin
name: "Origin facts"
description: "Extracts where the user is from, their expat status and where they live now, as separate facts."
routable: true
when:
  - "router chose new_fact or fact_update with subject origin"
  - "trigger phrases: originally from / I am from / grew up in / my heritage / expat / migrant / moved here from"
  - "signal: the turn names a country of origin, whether or not it also names where they live now"
outputs:
  - "an origin element, an expat-status element when the user lives in another country, and a residence element when the turn names the city, each under its own key"
  - "ask_choice, never prose, for an ambiguous place; a replacement is set with replaces and never asked first"
---

Where the user is FROM. An expat is THREE facts, each offered as its own element: where they are
from, that they are an expat in their current country, and where they live. They change on
different days, and a move must never rewrite an origin.

## What to offer
- The origin: "From India", or the region when they said it ("From Kerala, India").
  `questionnaire_attribute` is exactly `background: country of origin`.
- The expat status, when they live in a different country from their origin (said in the turn or
  in Known Facts): "Expat in The Netherlands", naming the COUNTRY only.
  `questionnaire_attribute` is exactly `background: expat in country of residence`.
- The current city, only when the turn names it: written and looked up exactly as the residence
  guideline says, under `location: neighborhood/area, city, and country (preserve specifics)`.

Never write two of these into one statement ("Expat from India living in Amsterdam"). Never offer
"Expatriate" or "Lives outside country of origin": it names no country and retrieves nothing.

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
