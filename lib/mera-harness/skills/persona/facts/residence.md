---
id: facts/residence
name: "Residence facts"
description: "Extracts where the user lives, resolves the place to a full chain, and offers it."
when:
  - "router chose new_fact or fact_update with subject residence"
  - "trigger phrases: I live in / I moved to / I am based in / I study in / my flat / my neighbourhood"
  - "signal: the user names a place and the sentence subject is the user"
outputs:
  - "one leg issuing lookup_place and find_similar_facts together, then one saveExtractedFacts call"
  - "the residence element carries only rungs lookup_place returned, plus the attribute key location: neighborhood/area, city, and country (preserve specifics)"
  - "ask_choice, never prose, for a place choice or a replacement"
---

The turn is about where the user themselves lives. Offer it. Never save it.

## What to extract
One fact: the user's current residence, in English, under 200 characters, with the place expanded
to its full chain. Fill every rung the lookup gives you and invent none.

- Good: "Lives in Gràcia, Barcelona, Catalonia, Spain, Europe"
- Bad: "Lives in Barcelona". The rungs are dropped and every later topic run loses them.
- Bad: "User lives in Spain". The chain collapsed upward instead of down.

Residence is one fact. A turn that also carries a job or a partner carries other facts too: offer
each as its own element.

**Origin plus residence is one fact, not two.** If the turn says the user is an expat, a migrant, or
originally from somewhere else, and also gives their current city, that is one statement: "Expat
from India living in Amsterdam, Netherlands, Europe". Never split it, and never offer "Expatriate /
lives outside country of origin", which names no country at all.

A move is still one fact. Offer the new residence and let the replacement rule below retire the old
one. Offer a second reading only when the two would retrieve different news.

## Both lookups in one leg
`lookup_place` takes `{ query, countryHint? }`, where `query` is the raw place words.
`find_similar_facts` takes `{ kind? }` and nothing else. Send both in one response: neither needs
the other's answer, so sequencing them costs the user a round trip and buys nothing.

## Reading lookup_place
The statuses are `resolved`, `no_match`, `too_short` and `unavailable`. A `resolved` answer carries
`places`, one to three of `{ neighbourhood?, locality, admin1, countryCode, countryName, bloc }`.

- **One place**: use it. Build the statement from the rungs that place actually carries, in order,
  and stop at the last one present. Never add a rung the place does not carry and never work your way
  to a continent: `bloc` is filled in code, so copy it.
  `neighbourhood` is the user's own words and nothing else. Code checks it appears in their turn and
  drops it when it does not, so a neighbourhood you spelled but never heard is discarded and the fact
  quietly loses a rung. Never supply one you did not hear.
- **Two or three places**: call `ask_choice` with one short option per place. Offer no residence
  fact this turn.
- **no_match**: if the words are ambiguous on their face (Newcastle, Springfield, Georgia), call
  `ask_choice` with their words and "somewhere else". Otherwise offer their words with only the rung
  they themselves named, usually the country, and nothing inferred. Never guess a country.
- **too_short**: too little to place ("I moved"). Ask for the city and offer nothing.
- **unavailable**: the lookup failed, which is not the user's problem. Offer their own words with no
  rungs added and do not mention the tool.

## Confirmations go through ask_choice
The two things you may need confirmed, the place and a replacement, are both `ask_choice` calls with
two or three short options. Never ask for either in prose that needs a typed reply: a question the
user has to answer in words is one they can also ignore, and then you are guessing anyway.

Option labels are text the user reads, so they follow the same rule your prose does. Nothing is
saved yet, so no option says "saved", "added" or "noted".

If a choice goes unanswered, do not ask it again. Take the reading their other facts support and
offer it, and where the choice was a replacement, **offer both facts rather than replacing one**.
A fact the user can remove is recoverable. One you deleted for them is not.

## Reading find_similar_facts
Branch on the attribute key, never on the score.

- Same key, **different** place: a replacement, and it is the user's to make. `ask_choice` between
  the two places, and set `replaces` only on an explicit choice.
- Same key, same place at a **deeper** rung ("Lives in Barcelona" against "Lives in Gràcia,
  Barcelona"): set `replaces` and say so in one line. No choice is needed, because nothing is lost.
- A **different** key: not a replacement. A relative's address, a workplace and a residence all
  coexist.

## What to offer
`questionnaire_attribute` must be exactly `location: neighborhood/area, city, and country
(preserve specifics)`, to the character. That exact string is what marks the fact as the user's own
home; a near miss still half works, which is worse than failing, because it then loses to any other
fact whose key merely starts with "location". Anchoring for every future topic run rests on it.
