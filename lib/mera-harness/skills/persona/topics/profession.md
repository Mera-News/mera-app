---
id: topics/profession
name: "Profession topics"
description: "Turns a job, field or employer fact into field news, then its national and bloc flavours."
when:
  - "the fact names what the user does for a living, their employer, field or industry"
  - "trigger phrases: works as / works at / senior / engineer / nurse / teacher / studying toward"
  - "the fact names a professional interest rather than a hobby"
outputs:
  - "a JSON array of 2-to-5-word topic strings, at most 10, nothing before or after it"
  - "at least two topics naming no place"
  - "at most one topic naming the employer"
examples:
  - "hospital staffing shortages"
  - "nurse prescribing rules"
  - "drug approval decisions"
  - "patient safety inquiries"
  - "Ireland health service pay"
  - "Ireland nursing recruitment"
  - "EU health workforce directive"
  - "EU cross-border healthcare"
---

The fact is what the user does. A profession is unanchored by default: the field is the subject, and
a place joins only as a flavour of it.

## The three bands, in order
1. **Field-generic, at least two, naming no place.** What the field itself is in the news for. For a
   software role that is AI, cyber security and developer tooling; for a clinical role it is
   workforce, licensing and drug approvals; for a legal role it is rulings and regulation. Name the
   field's live subjects, never the field itself.
2. **National flavour.** The same field inside the country the persona's residence fact names. Read
   that country off their other facts. If they have no residence fact, skip this band entirely
   rather than guessing a country.
3. **Bloc flavour.** The same field at the bloc, where the bloc genuinely legislates for it.

At most 10 in total. A field with a thin news surface honestly yields five.

## The employer
At most one topic may name the employer, and only when the employer is large enough that a
newsroom writes about it. A small firm gets none: a topic naming it retrieves nothing, every day,
for as long as the fact lives.

## Every topic carries a bridge
This is the guideline where the banned shapes bite hardest, because a field name plus an abstract
noun feels like a topic and is not. Every topic names a place, an organisation, a policy or law, or
a specific event or action.

- Bad: "nursing industry trends", "legal career development", "software awards".
- Good: "nurse prescribing rules", "drug approval decisions", "AI copyright ruling".

If you cannot say what would appear in the article, the topic is not one.

## Never
- The residence place as the subject. "Barcelona news" is the residence fact's run, not this one.
- A personal name, including the user's own. Use the role.
- A credential acronym: write "tax accountant", "physician", "engineer", never CPA, MD, FRCS, JD or
  BEng. They are tied to one country's system and identify the reader.
- Any prohibition above. They all still stand.

## Worked example
Fact: "Theatre nurse at a public hospital"
Other facts: "Expat from the Philippines living in Dublin, Leinster, Ireland, Europe"
Existing topics: "Ireland qualification recognition"

Four field-generic topics naming no place, two national, two bloc. The employer is a public
hospital with no name in the fact, so no topic names one. "Ireland qualification recognition" is
excluded, so the national band goes to pay and recruitment instead.

```json
["hospital staffing shortages", "nurse prescribing rules", "drug approval decisions", "patient safety inquiries", "Ireland health service pay", "Ireland nursing recruitment", "EU health workforce directive", "EU cross-border healthcare"]
```

Read the shapes, not the field. A software or legal fact must produce none of these strings.
