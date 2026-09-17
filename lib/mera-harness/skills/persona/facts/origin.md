---
id: facts/origin
name: "Origin facts"
description: "Extracts where the user is from and composes it with where they live into one fact."
routable: true
when:
  - "router chose new_fact or fact_update with subject origin"
  - "trigger phrases: originally from / I am from / grew up in / my heritage / expat / migrant / moved here from"
  - "signal: the turn names a country of origin, whether or not it also names where they live now"
outputs:
  - "one saveExtractedFacts call carrying exactly ONE identity element, never two"
  - "attribute key background: origin and current residence"
  - "ask_choice, never prose, for a place choice or a replacement"
---

Where the user is FROM. Origin and current residence are one concept, and this guideline owns both
halves of it.

## Origin plus residence is ONE fact
Apart they are useless and together they are the whole thing. This is the single exception to one
concept per fact.

- Known Facts already give a current city: offer exactly ONE element, "Expat from India living in
  Amsterdam, Netherlands, Europe". Nothing else for this. No separate origin element and no
  separate residence element.
- No current city known yet: offer ONE element naming the origin, "Expat originally from India",
  and ask for the city. Compose the two on the next turn.

Never offer "Expatriate", "Lives outside country of origin" or any wording of that shape. It names
no country, so it retrieves nothing and it can never be composed with anything later. It is a
placeholder, not a fact.

## Both lookups in one leg
Issue `lookup_place` and `find_similar_facts` in the same response. `lookup_place` takes
`{ query, countryHint? }` where `query` is the raw place words. `find_similar_facts` takes
`{ kind? }` and nothing else. Read the place result exactly as the residence guideline does: one
place proceeds, two or three go to `ask_choice`, and `bloc` is copied from what came back rather
than worked out.

When the turn names two places, the origin and the current city, look up the CURRENT one. The
origin country needs no chain: a country is the whole of it, and "Expat from Kerala, India" is
better than either half only when the user said Kerala.

## Neutral words only
Write "expat", "diaspora", "overseas citizen", "moved from". Never a country-specific label or
acronym: not NRI, not OCI, not PIO, not DACA, not H-1B. Each is tied to one country's nationals and
narrows who the reader could be far more than the plain word does.

Do not add a nationality the user did not claim. "I grew up in Lagos" is where they grew up. It is
not a claim to Nigerian citizenship, and a fact that asserts one is wrong in a way they may never
see.

## Checking what is already known
Branch on the attribute key, never on the score.

- An existing origin fact, different country: this is a correction, and it is theirs to make.
  `ask_choice` between the two, and set `replaces` only on an explicit choice.
- An existing residence fact and the turn adds an origin: do NOT replace it. Offer the composed
  fact with `replaces` set to the residence fact, so one card carries the whole identity instead of
  two cards splitting it.
- An existing composed fact and the turn changes only the city: offer the recomposed fact with
  `replaces` set.

If a choice goes unanswered, offer both facts rather than replacing one. A fact they can remove is
recoverable; one deleted on a guess is not.

## What to offer
`questionnaire_attribute` is `background: origin and current residence` for every element this
guideline offers, composed or not. It is what lets a later turn find this fact and recompose it.
