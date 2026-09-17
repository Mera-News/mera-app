---
id: topics/family
name: "Family topics"
description: "Turns a relative, household or life-event fact into topics that stay where the fact put them."
when:
  - "the fact names a partner, child, parent, sibling or care duty"
  - "the fact says where a relative lives or is staying"
  - "the fact names a life event: a birth, a marriage, moving in together, a bereavement, a retirement, a diagnosis"
outputs:
  - "a JSON array of 2-to-5-word topic strings, at most 8, nothing before or after it"
  - "every place-bearing topic names the exact place the fact named, and no larger one"
  - "[] when the fact supports nothing honest"
examples:
  - "Chhindwara news"
  - "Chhindwara safety"
  - "Chhindwara weather"
  - "Chhindwara hospital capacity"
  - "Chhindwara civic issues"
  - "Chhindwara power supply"
---

Someone other than the user is somewhere, or something has changed in the household. Emit at most 8.

## Stay exactly where the fact put you
When the fact names a place, every place-bearing topic names THAT place and no other. Do not ladder
to its region, its country or its continent. The user does not live there and the relative does not
read the national press about themselves.

- Good, for parents in Chhindwara: "Chhindwara news", "Chhindwara hospital capacity".
- Bad: "Madhya Pradesh politics", "India elections", "India monsoon", "Asia news".

**Micro-locality exception, one step only.** If the place is a village, a small island or a hamlet
with no press of its own, you may take exactly one step up, to its named archipelago, metro area or
immediate district, and no further. A district town has enough local news of its own: stay put.

## Visiting is not travel
"Parents are travelling in X" and "parents live in X" get the SAME topics. A person present in a
place wants that place's local news: local reporting, safety, weather, transport, healthcare, civic
issues. Never switch the subject to visas, travel advisories, flight delays or trip insurance
because the word "travelling" appeared. That is logistics for the trip, not news from the place.

## The daily round
At most two daily-life topics, using the service-disruption sense: transport, water, power, waste.
No floor here. A small place may honestly have no disruption coverage at all, and a short output is
the right answer.

## Life events
A birth, a marriage, moving in together, a bereavement, a retirement, a diagnosis. These yield
POLICY and DEMOGRAPHIC topics, never a service you would hire.

- Good: "parental leave reform", "eldercare policy debate", "pension age changes",
  "childcare funding".
- Bad: "elder care services", "funeral directors", "legal aid for families", "childcare help near
  me". Each is a thing you hire, and hiring is not news.

A life event also goes stale. Prefer the policy around it, which keeps reading well a year later,
over the moment itself.

## Never
- The user as the subject. Their own residence, work and interests have their own runs.
- A relative's name, or a relationship specific enough to identify them. Roles only.
- Any prohibition above. They all still stand.

## Worked example
Fact: "Parents are currently travelling in Chhindwara, India"
Other facts: "Works in logistics"; "Lives in Gràcia, Barcelona, Catalonia, Spain, Europe"
Existing topics: none

Relational and temporary, so the same set as living there, and no ladder. No Madhya Pradesh, no
India, no Asia, and nothing about the logistics job or Barcelona. Two daily-life topics, weather
and power. Six is the honest length; the ceiling of 8 is not a target.

```json
["Chhindwara news", "Chhindwara safety", "Chhindwara weather", "Chhindwara hospital capacity", "Chhindwara civic issues", "Chhindwara power supply"]
```

Read the shape, not the place.
