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
  - "a JSON array of 2-to-5-word topic strings, at most 12, nothing before or after it"
  - "one topic per rung the fact names, FIRST in the array, in rung order, before anything else"
  - "[] when the fact names no place to ladder"
examples:
  - "Gràcia neighbourhood news"
  - "Barcelona news"
  - "Catalonia regional politics"
  - "Spain immigration policy"
  - "EU housing regulation"
  - "Gràcia housing pressure"
  - "Barcelona metro disruptions"
  - "Barcelona school places"
  - "Catalonia nursing pay dispute"
  - "Spain rail strikes"
  - "Spain energy prices"
  - "Schengen entry rules"
---

The fact is the user's own residence. Its place chain is the spine of the output.

## How many
Count the rungs the fact statement **actually carries**, not the rungs it could have had. A
residence statement is built only from what the place lookup returned, so a fact may name four
rungs, or three, or two. Emit at most three topics per rung and never more than 12 in total. A
two-rung fact earns at most six topics; a five-rung chain earns up to 12.

Never invent a rung to widen the budget. No region in the statement means no region rung, and a
topic aimed at a rung the fact does not name retrieves news about a place the user never
mentioned.

## The chain comes first, and it is mandatory
Every rung the fact names gets at least one topic that NAMES that rung, and those topics come FIRST
in the array, in rung order from smallest to largest. A five-rung fact opens with five topics, one
per rung, in order. Emit them before anything else: before the daily round, before any
cross-product, before a second topic on any rung.

For "Lives in Gràcia, Barcelona, Catalonia, Spain, Europe" the array opens with a Gràcia topic, a
Barcelona topic, a Catalonia topic, a Spain topic, then an EU topic.

A missing rung is a gap the user cannot see and cannot ask you for. The count rule caps how MANY
topics you emit; it never makes the chain optional. If the ceiling is tight, spend it on the chain
and drop the extras.

Granularity above still applies to the chain. A neighbourhood or city rung may be broad, "<place>
news" included, and that is the one place filler of that shape is allowed; a country or bloc rung
stays specific, so the country rung reads "Spain immigration policy" and never "Spain news".

**The bloc rung is mandatory whenever the fact carries one, and it is the one that gets dropped.**
It sits last, so emit it before you spend anything on a second city topic. Use the bloc shapes
above. A chain stopping at the country loses migration, trade and energy, which is most of what
reaches a resident from above their own government.

Fill what budget is left with further rung topics, the daily round and cross-products.

## The daily round
One or two daily-life topics, no more: a transport one at the city rung, a public-services one at
the country rung. Good: "Barcelona metro disruptions", "Spain rail strikes".

A daily-life topic is a service disrupted, struck, delayed or cut: metro, tram, bus, rail,
roadworks, water, power, waste. Housing, schools, healthcare or energy **policy** is not one, it is
an ordinary rung topic and does not count against this cap.

## Cross-products
Let the persona's other facts shade the residence topics without ever taking the subject away from
the place. The place is the subject of every topic here.

- Good: residence Spain plus profession paediatric nurse gives "Spain nursing pay dispute".
- Bad: "nursing shortage news". That belongs to the profession fact's own run, not to this one.

At most three of the output may be cross-products. The rest belong to the plain chain.

## Exclude
One addition to the exclusion rules above, because it bites hardest on a place chain: a rung name
is not what makes a topic new. If "logistics jobs" is already in the persona's topics, then
"Barcelona logistics jobs" is a duplicate wearing a hat.

## Never
A country other than the fact's own country and its bloc. Every prohibition above still stands.

## Worked example
Fact: "Lives in Gràcia, Barcelona, Catalonia, Spain, Europe"
Other facts: "Paediatric nurse at a public hospital"; "Has two children in primary school"
Existing topics: "Spain healthcare reform"

Five rungs, so up to 12, at most three per rung. The first five are the chain, one per rung in
order, bloc included, and nothing comes before them. The remaining seven: a second Gràcia topic,
two daily-life ("Barcelona metro disruptions", "Spain rail strikes"), two cross-products keeping
the place as subject, and two further country and bloc topics. "Spain healthcare reform" is
excluded, so the nursing cross-product moves to the region rung rather than being dropped.

```json
["Gràcia neighbourhood news", "Barcelona news", "Catalonia regional politics", "Spain immigration policy", "EU housing regulation", "Gràcia housing pressure", "Barcelona metro disruptions", "Barcelona school places", "Catalonia nursing pay dispute", "Spain rail strikes", "Spain energy prices", "Schengen entry rules"]
```

Read the shapes, not the places. A fact naming a different country must produce none of these
strings.

Reply with the JSON array and nothing else. No sentence before it, none after.
