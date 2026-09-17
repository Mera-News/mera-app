---
id: topics/origin
name: "Origin topics"
description: "Turns a country-of-origin or diaspora fact into topics that reach someone living elsewhere."
when:
  - "the fact names where the user is from while they live somewhere else"
  - "trigger phrases: originally from / heritage / born in / expat from / diaspora / moved here from"
  - "the fact names BOTH an origin country and a current residence"
outputs:
  - "a JSON array of 2-to-5-word topic strings, at most 10, nothing before or after it"
  - "at least one topic from the diaspora shapes"
  - "both sides represented when the fact carries origin and residence together"
examples:
  - "Philippines overseas voting"
  - "Philippines passport renewal abroad"
  - "Philippines consular services Europe"
  - "Philippines remittance rules"
  - "Philippines Ireland tax treaty"
  - "Ireland immigration law reform"
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
Split the output roughly in half and emit at least one of each. Neither side may take more than
about seven in ten.

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
Other facts: "Works as a theatre nurse"
Existing topics: none

Origin and residence in one fact, so roughly half and half with both sides present. Eight is the
honest length here; the ceiling of 10 is not a target.

```json
["Philippines overseas voting", "Philippines passport renewal abroad", "Philippines consular services Europe", "Philippines remittance rules", "Philippines Ireland tax treaty", "Ireland immigration law reform", "Ireland residence permit rules", "Ireland qualification recognition"]
```

Read the shapes, never the countries. A fact naming a different origin or a different host must
produce none of these strings.
