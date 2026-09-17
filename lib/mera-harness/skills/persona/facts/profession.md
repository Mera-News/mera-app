---
id: facts/profession
name: "Profession facts"
description: "Extracts what the user does for a living, at the specificity that makes it retrievable."
routable: true
when:
  - "router chose new_fact or fact_update with subject profession"
  - "trigger phrases: I work / I am a / my job / my employer / I study / I am training as"
  - "signal: the turn names a role, an employer, a field or an industry"
outputs:
  - "one saveExtractedFacts call, one element per distinct professional fact"
  - "attribute key profession: role, employer, and field"
  - "no place in the statement"
---

What the user does for a living. Specific enough to retrieve news, and anchored to nothing.

## Specific, not categorical
A vague profession fact produces vague topics, and vague topics fill a feed with things nobody
asked for.

- Good: "Senior ML engineer at DeepMind", "Theatre nurse at a public hospital", "Solicitor
  specialising in employment law".
- Bad: "Works in tech", "Works in healthcare", "Has a job in law".

Keep the seniority, the employer and the speciality when they said them. Do not invent any of the
three when they did not.

## No place in the statement
A profession fact never carries the city or country the user lives in. That belongs to their
residence fact, and the topic run reads both. Putting the place here duplicates it, and a later move
then leaves two facts disagreeing about where they are.

- Good: "Theatre nurse at a public hospital".
- Bad: "Theatre nurse at a public hospital in Dublin".

The exception is an employer whose name contains a place, which is the employer's name and stays
exactly as they said it.

## Split, and infer the obvious sibling
- SPLIT what is two things. "software engineer and expat from India" is a profession element and an
  identity element. Offer the profession one here and let the identity element carry its own
  attribute key.
- INFER the obvious sibling as a SECOND element, never by rewriting the first. "Works at Google"
  also supports "Works in the technology industry". Offer both, as two elements. An inference folded
  into the first statement is a fact they never get to decline on its own.

Offer an inferred sibling only where it is genuinely obvious from the employer or the role. A
speciality, a seniority or an opinion about the field is not an inference, it is a guess.

## A change of job is a replacement
`find_similar_facts` takes `{ kind? }` and nothing else. Branch on the attribute key.

- Same key, different employer or role: a correction. `ask_choice` between the two, and set
  `replaces` only on an explicit choice. A promotion is the same subject: "got promoted to senior"
  with a known "Works at Google" recomposes to "Senior engineer at Google".
- Different key: not a replacement. A job, a residence and a relative's address all coexist.
- Unanswered choice: offer both rather than replacing one.

## What to offer
`questionnaire_attribute` is `profession: role, employer, and field`. An inferred industry sibling
takes the same key: it is the same subject at a coarser grain.
