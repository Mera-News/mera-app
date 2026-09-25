---
id: topics/residence
name: "Residence topics"
description: "Turns a residence fact into news topics along its place chain, plus the daily round."
routable: false
when:
  - "the fact says where the user themselves lives"
  - "signal: the statement opens with Lives in / Moved to / Based in / Studies in"
  - "the fact's attribute key is location: neighborhood/area, city, and country"
outputs:
  - "a JSON array of 2-to-5-word topic strings, at most 20, nothing before or after it"
  - "one topic per rung the fact names, FIRST in the array, in rung order, before anything else"
  - "one SAFETY topic at the place the user actually lives, always"
  - "[] when the fact names no place to ladder"
examples:
  - "Gràcia neighbourhood news"
  - "Barcelona news"
  - "Catalonia regional politics"
  - "Spain immigration policy"
  - "EU housing regulation"
  - "Gràcia street safety"
  - "Gràcia housing pressure"
  - "Barcelona metro disruptions"
  - "Spain rail strikes"
  - "Spain energy prices"
  - "Schengen entry rules"
---

The fact is the user's own residence. Its place chain is the spine of the output.

## How many
Count the rungs the fact statement **actually carries**, not the rungs it could have had: a
statement is built only from what the place lookup returned. Emit at most four topics per rung and
never more than 20 in total, so a two-rung fact earns at most eight and a five-rung chain up to 20.

Residence ladders further than any other fact, so its ceiling is the highest here. It is still a
ceiling: a two-rung fact does not reach twenty by padding.

Never invent a rung to widen the budget: a topic aimed at a rung the fact does not name retrieves
news about a place the user never mentioned.

## The chain comes first, and it is mandatory
Every rung the fact names gets at least one topic that NAMES that rung, and those come FIRST, in
rung order from smallest to largest, before the daily round, before a
second topic on any rung. "Lives in Gràcia, Barcelona, Catalonia, Spain, Europe" opens with a
Gràcia topic, a Barcelona one, a Catalonia one, a Spain one, then an EU one.

A missing rung is a gap the user cannot see and cannot ask you for, so if the ceiling is tight,
spend it on the chain and drop the extras.

Granularity above still applies: a neighbourhood or city rung may be broad, "<place> news"
included, and that is the one place filler of that shape is allowed; a country or bloc rung stays
specific, so it reads "Spain immigration policy" and never "Spain news".

**The bloc rung is mandatory whenever the fact carries one, and it is the one that gets dropped.**
It sits last, so emit it before any second city topic. A chain stopping at the country loses
migration, trade and energy, which is most of what reaches a resident from above their own
government.

Fill what is left with further rung topics and the daily round.

When the first rung reads "Name (Other)", Name is what the user calls the place, and at least one
topic uses Name itself: a place they named that no topic mentions is news they never see.

## Safety, and it is mandatory
**One safety topic at the place the user actually lives**: the neighbourhood rung when the fact
names one, the city rung otherwise. It sits with the daily round, after the chain.

Crime, policing, street safety. "Gràcia street safety" and "Barcelona police response times" both
work. Never at the country rung, which retrieves national crime statistics nobody lives inside,
and never phrased as a worry: "Is Gràcia dangerous" fetches the worst article on the page.

One, and at most two. Safety is one facet of living somewhere, not the subject of the fact.

## The daily round
One or two daily-life topics, no more: a transport one at the city rung, a public-services one at
the country rung. Good: "Barcelona metro disruptions", "Spain rail strikes".

A daily-life topic is a service disrupted, struck, delayed or cut: metro, tram, bus, rail,
roadworks, water, power, waste. Housing, schools, healthcare or energy **policy** is an ordinary
rung topic and does not count against this cap.

## Exclude
A rung name is not what makes a topic new. If "logistics jobs" is already among this fact's topics,
"Barcelona logistics jobs" is a duplicate wearing a hat.

## Never
A country other than the fact's own country and its bloc. Every prohibition above still stands.

## Worked example
Fact: "Lives in Gràcia, Barcelona, Catalonia, Spain, Europe"
Existing topics: "Spain healthcare reform"

Five rungs, so up to 20, at most four per rung. The first five are the chain, in order, bloc
included. Then the mandatory safety topic, the daily round and further rung topics. "Spain
healthcare reform" is excluded, so no healthcare topic repeats it.

```json
["Gràcia neighbourhood news", "Barcelona news", "Catalonia regional politics", "Spain immigration policy", "EU housing regulation", "Gràcia street safety", "Gràcia housing pressure", "Barcelona metro disruptions", "Spain rail strikes", "Spain energy prices", "Schengen entry rules"]
```

Eleven, not twenty: the ceiling is what the chain can carry, never a quota to fill.

Read the shapes, not the places. A fact naming a different country must produce none of these
strings.

Reply with the JSON array and nothing else. No sentence before it, none after.
