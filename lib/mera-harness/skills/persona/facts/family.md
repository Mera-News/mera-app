---
id: facts/family
name: "Family facts"
description: "Extracts household, relatives and life events, keeping a relative's place separate from the user's."
routable: true
when:
  - "router chose new_fact or fact_update with subject family"
  - "trigger phrases: my partner / my kids / my parents / my sister / I look after / we are expecting"
  - "signal: the turn says where a relative lives or is staying, or names a life event"
outputs:
  - "one saveExtractedFacts call, one element per distinct family fact"
  - "a relative's place carries its own attribute key and never touches the user's residence fact"
  - "ask_choice, never prose, for a place choice or a replacement"
---

The household, the relatives, and what has changed. The user is the subject of none of it.

## A relative's place is not the user's place
This is the rule the whole guideline turns on. "My parents live in Bhopal" says nothing about where
the user lives. It never replaces their residence fact, it never updates it, and it never merges
with it. Two people, two places, two facts.

Offer the relative's place as its own element under its own attribute key, with the chain
`lookup_place` returned. `lookup_place` takes `{ query, countryHint? }`; `find_similar_facts` takes
`{ kind? }` and nothing else; issue both in one response.

- Good: "Parents live in Bhopal, Madhya Pradesh, India, Asia".
- Bad: anything that edits the user's own residence because a relative was mentioned.

## Staying is not living, and say which
Record the word they used. "My parents are travelling in Chhindwara" and "my parents live in
Chhindwara" are different facts, and the topic run reads the difference.

- Good: "Parents are currently travelling in Chhindwara, India".
- Good: "Parents live in Bhopal, Madhya Pradesh, India, Asia".

A temporary stay goes stale on its own. Offer it anyway, in their words. Do not silently upgrade a
visit into a residence because the chain looks tidier that way.

## Roles, never names
"My sister Priya" is "Has a sister". The name adds nothing retrievable and everything identifying.
The same goes for a school, an employer or a clinic belonging to a relative: the role is the fact.

Do not record a relative's age, a diagnosis in clinical detail, or anything about a child beyond
what the news would be about. "Has two children in primary school" is a fact. A child's name, school
or birth date is not one this app has any use for.

## Life events
A birth, a marriage, moving in together, a bereavement, a retirement, a diagnosis. Offer the event,
not a number computed from it: "Expecting a first child" rather than a due date, "Recently retired"
rather than an age. A number goes wrong within months and nothing goes back to fix it.

`questionnaire_attribute` for a life event is `family: household and life events`. For a relative's
location it is `family: relative location`, which is what keeps it out of every lookup that reads
the user's own residence.

## Replacements
Branch on the attribute key.

- Same key, a relative moved: a correction. `ask_choice` between the two places, and set `replaces`
  only on an explicit choice.
- A life event superseding an earlier one, such as a birth after an expected birth: offer the new
  element with `replaces` set to the old, and say so in one line. No choice is needed, because the
  earlier fact was always going to expire.
- Unanswered choice: offer both rather than replacing one.
