---
id: topics/origin
name: "Origin topics"
description: "Turns a country-of-origin or diaspora fact into topics that reach someone living elsewhere."
routable: false
when:
  - "the fact names where the user is from while they live somewhere else"
  - "trigger phrases: originally from / heritage / born in / expat from / diaspora / moved here from"
  - "the fact names BOTH an origin country and a current residence"
outputs:
  - "a JSON array of 2-to-5-word topic strings, at most 10, nothing before or after it"
  - "at least one topic from the diaspora shapes"
  - "origin rung, host rung, then the host bloc rung FIRST in the array when the fact carries both"
examples:
  - "Philippines overseas voting"
  - "Ireland immigration law reform"
  - "EU migration policy"
  - "Philippines passport renewal abroad"
  - "Philippines consular services Europe"
  - "Philippines remittance rules"
  - "Philippines Ireland tax treaty"
  - "Ireland residence permit rules"
  - "Ireland qualification recognition"
---

The user LEFT the origin country. Everything here follows from that one fact.

## The domestic ladder is forbidden
A person who left does not need that country's daily domestic round. The ladder in the residence
guideline belongs to a place someone LIVES in, and reusing it here is the single worst failure this
guideline exists to prevent.

Never, for the origin country: elections, economy, budget, monsoon, cyclone, weather, pollution,
rail strikes, state or provincial politics, or a bare "<country> news". Every one of those is a
residence topic wearing an origin fact's clothes.

## Diaspora shapes
What reaches someone abroad is a rule that changed. Draw from these and stay inside them: visa and
entry rule changes, passport and consular services abroad, citizenship and overseas-citizen status,
remittance rules, double-tax treaties, customs and travel rules, property and inheritance rules for
citizens abroad, diaspora voting rights, diaspora community news.

Emit at most 10, and at least one from this list. Fewer is correct.

## When the fact carries origin AND residence
Two rungs exist, and both are MANDATORY and come FIRST, in this order: one topic naming the origin
country, then one naming the host country. Emit those two before anything else. Only then split the
rest of the output roughly in half between the two sides, with neither side taking more than about
seven in ten.

A composed fact that opens with two host-country topics has buried the half the user is least
likely to find anywhere else.

**Where the host country sits in a bloc, the host chain carries a bloc rung too, and it is
mandatory.** It is the rung that gets dropped, and for a migrant it is rarely the least useful one:
entry, residence and qualification rules are set above the host government as often as by it. Use
the bloc shapes above, and prefer the ones that reach a migrant: "EU migration policy", "EEA
residence rules", "Schengen entry rules", or the equivalent bloc for this host. It comes after the
origin and host rungs and before the rest of the split.

- Origin side: the rules above, the ones that reach citizens abroad.
- Host side: host-country law affecting migrants of that origin. Immigration and residence-permit
  reform, integration and language requirements, recognition of foreign qualifications, housing and
  tax rules for newcomers, host-country diaspora community news.

An origin fact that yields zero origin-country topics has failed, however good the host-side topics
are. That is the check to run on your own output before you answer.

## When origin and host are inside one bloc
Most diaspora shapes do not apply to a move that crossed no border control: there is no visa, no
entry rule, no consular queue and often no tax treaty question. A short honest output is the right
answer. Reach for what genuinely differs, such as pension and benefit portability, qualification
recognition, or voting from abroad, and stop when those run out.

## Never
- A service you would hire rather than a rule that changed. "Philippines visa services",
  "immigration lawyer Dublin" and "tax filing help for expats" are all out. The carve-out above
  covers legislating, never hiring.
- A nationality label or country-specific acronym. Write "expat", "diaspora", "overseas citizens".
- Any prohibition above. They all still stand.

## Worked example
Fact: "Expat from the Philippines living in Dublin, Leinster, Ireland, Europe"
Existing topics: none

Origin and residence in one fact. The first three topics are the rungs in order: origin, host,
then the host's bloc. The remaining six split roughly half and half. Nine here; the ceiling of 10
is not a target.

```json
["Philippines overseas voting", "Ireland immigration law reform", "EU migration policy", "Philippines passport renewal abroad", "Philippines consular services Europe", "Philippines remittance rules", "Philippines Ireland tax treaty", "Ireland residence permit rules", "Ireland qualification recognition"]
```

Read the shapes, never the countries. A fact naming a different origin or a different host must
produce none of these strings.

Reply with the JSON array and nothing else. No sentence before it, none after.
