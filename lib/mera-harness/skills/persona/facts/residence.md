---
id: facts/residence
name: "Residence facts"
description: "Extracts where the user lives, resolves the place to a full chain, and offers it."
routable: true
when:
  - "router chose new_fact or fact_update with subject residence"
  - "trigger phrases: I live in / I moved to / I am based in / I study in / my flat / my neighbourhood"
  - "signal: the user names a place and the sentence subject is the user"
outputs:
  - "one leg issuing lookup_place and find_similar_facts together, then one saveExtractedFacts call"
  - "the residence element carries only rungs lookup_place returned, plus the attribute key location: neighborhood/area, city, and country (preserve specifics)"
  - "ask_choice, never prose, for an ambiguous place; a replacement is set with replaces and never asked first"
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

**Where they are from is its own fact**, and so is being an expat. If the turn says the user is
an expat or from somewhere else, offer "From India" (`background: country of origin`) and
"Expat in The Netherlands" (`background: expat in country of residence`) as their own elements.
Never fold either into the residence statement. A move to another country is also an expat-status
change: Mera adds that update to the move itself.

A move is still one fact. Offer the new residence and let the replacement rule below retire the old
one. Offer a second reading only when the two would retrieve different news.

## Both lookups in one leg
`lookup_place` takes `{ query, countryHint? }`, where `query` is the raw place words.
`find_similar_facts` takes `{ kind? }` and nothing else. Send both in one response: neither needs
the other's answer, so sequencing them costs the user a round trip and buys nothing.

## Reading lookup_place
The statuses are `resolved`, `no_match`, `too_short` and `unavailable`. A `resolved` answer carries
`places`, one to three of `{ neighbourhood?, userTerm?, locality, admin1, countryCode, countryName,
bloc }`, and `unmatched`: the user's words the lookup could not place, usually a district.

- **One place**: use it. Build the statement from the rungs that place actually carries, in order,
  and stop at the last one present. Never add a rung the place does not carry and never work your way
  to a continent: `bloc` is filled in code, so copy it.
  A district comes only from the user's words (`unmatched`, or the finer area in the state line).
  Put it first, spelled the usual way: an obvious typo is offered corrected ("niew west" is
  "Nieuw-West, Amsterdam, ..."), never asked about. Code drops a district they did not say.
  With `userTerm`, their own name leads: "Porto Santo (Vila Baleira), Madeira, Portugal, EU".
- **Two or three places**: call `ask_choice` with one short option per place. Offer no residence
  fact this turn.
- **no_match**: if the words are ambiguous on their face (Newcastle, Springfield, Georgia), call
  `ask_choice` with their words and "somewhere else". Otherwise offer their own words, spelled
  normally, with only the rung they named. Never invent alternatives and never guess a country.
- **too_short**: too little to place ("I moved"). Ask for the city and offer nothing.
- **unavailable**: the lookup failed, which is not the user's problem. Offer their own words with no
  rungs added and do not mention the tool.
- After `no_match` or `unavailable` only, `webSearch` may say what the place is. Its result never
  becomes a rung; rungs come only from `lookup_place`.

## Only an ambiguous place is asked
An ambiguous place is an `ask_choice` call with two or three short options, never a question in
prose. A replacement is never asked: set `replaces` and the card shows the user what it removes and
lets them decide there.

Option labels are text the user reads, so they follow the same rule your prose does. Nothing is
saved yet, so no option says "saved", "added" or "noted".

If the place choice goes unanswered, do not ask it again. Take the reading their other facts
support and offer it.

## Reading find_similar_facts
Branch on the attribute key, never on the score.

- Same key, **different** place: a move. Set `replaces` to that id and do not ask first.
- Same key, same place at a **deeper** rung ("Lives in Barcelona" against "Lives in Gràcia,
  Barcelona"): set `replaces` and say so in one line. No choice is needed, because nothing is lost.
- A **different** key: not a replacement. A relative's address, a workplace and a residence all
  coexist. An older fact under `background: origin and current residence` is left alone too: Mera
  offers to split it on its own.

## What to offer
`questionnaire_attribute` must be exactly `location: neighborhood/area, city, and country
(preserve specifics)`, to the character. That exact string is what marks the fact as the user's own
home; a near miss still half works, which is worse than failing, because it then loses to any other
fact whose key merely starts with "location". Anchoring for every future topic run rests on it.
