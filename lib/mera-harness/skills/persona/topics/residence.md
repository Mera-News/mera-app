---
id: topics/residence
name: "Residence topics"
description: "Turns a residence fact into news topics along its place chain, plus the daily round."
when:
  - "the fact says where the user themselves lives"
  - "signal: the statement opens with Lives in / Moved to / Based in / Studies in"
  - "the fact's attribute key is location: neighborhood/area, city, and country"
outputs:
  - "a JSON array of 2-to-5-word topic strings, at most 12, nothing before or after it"
  - "at least one topic for every place rung the fact names"
  - "[] when the fact names no place to ladder"
examples:
  - "Gràcia neighbourhood news"
  - "Gràcia housing pressure"
  - "Barcelona news"
  - "Barcelona metro disruptions"
  - "Barcelona school places"
  - "Catalonia nursing pay dispute"
  - "Catalonia regional politics"
  - "Spain rail strikes"
  - "Spain immigration policy"
  - "Spain energy prices"
  - "EU housing regulation"
  - "Schengen entry rules"
---

The fact is the user's own residence. Its place chain is the spine of the output.

## How many
Count the rungs the fact statement **actually carries**, not the rungs it could have had. A
residence statement is built only from what the place lookup returned, so a fact may name four
rungs, or three, or two. Emit at most three topics per rung and never more than 12 in total. A
two-rung fact earns at most six topics; a five-rung chain earns up to 12.

Never invent a rung to widen the budget. If the statement names no region, there is no region rung
and no region topic, and a shorter output is the correct one. A topic aimed at a rung the fact does
not name retrieves news about a place the user never mentioned.

## The ladder
Every rung the fact names gets at least one topic, and topics get more specific as the rung gets
bigger. Granularity by scope is set out above and applies here unchanged.

## The daily round
Residents need the practical coverage nobody writes a think piece about. Emit at least one and at
most two daily-life topics: a transport one at the city rung, a public-services one at the country
rung.

- Good: "Barcelona metro disruptions", "Spain rail strikes"

A daily-life topic is about a service being disrupted, struck, delayed or cut: metro, tram, bus,
rail, roadworks, water, power, waste collection. A topic about housing, schools, healthcare or
energy **policy** is not a daily-life topic, it is an ordinary rung topic, and it does not count
against this cap. More than two of the disruption kind and the output stops being a news feed and
starts being a utilities dashboard.

## Cross-products
Let the persona's other facts shade the residence topics without ever taking the subject away from
the place. The place is the subject of every topic here.

- Good: residence Spain plus profession paediatric nurse gives "Spain nursing pay dispute".
- Good: residence Catalonia plus family two children in school gives "Catalonia school funding".
- Bad: "nursing shortage news". That belongs to the profession fact's own run, not to this one.

At most three of the output may be cross-products. The rest belong to the plain chain.

## Exclude
The exclusion rules above apply here, with one addition that bites hardest on a place chain: a rung
name is not what makes a topic new. If "logistics jobs" is already in the persona's topics, then
"Barcelona logistics jobs" is a duplicate wearing a hat.

## Never
A country other than the fact's own country and its bloc. Every prohibition above still stands.

## Worked example
Fact: "Lives in Gràcia, Barcelona, Catalonia, Spain, Europe"
Other facts: "Paediatric nurse at a public hospital"; "Has two children in primary school"
Existing topics: "Spain healthcare reform"

Five rungs, so up to 12, at most three per rung. The distribution below is 2 / 3 / 2 / 3 / 2.
Exactly two daily-life topics: "Barcelona metro disruptions" at the city rung and "Spain rail
strikes" at the country rung. "Barcelona school places", "Spain energy prices" and "EU housing
regulation" are policy topics, so they do not count against that cap. Two cross-products, both
keeping the place as subject. "Spain healthcare reform" is excluded, so the nursing cross-product
moves to the region rung rather than being dropped.

```json
["Gràcia neighbourhood news", "Gràcia housing pressure", "Barcelona news", "Barcelona metro disruptions", "Barcelona school places", "Catalonia nursing pay dispute", "Catalonia regional politics", "Spain rail strikes", "Spain immigration policy", "Spain energy prices", "EU housing regulation", "Schengen entry rules"]
```

Read the shapes, not the places. A fact naming a different country must produce none of these
strings.
