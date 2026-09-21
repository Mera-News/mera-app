---
id: facts/interest
name: "Interest facts"
routable: true
description: "Extracts a hobby, sport, team, artist, genre or game, and offers it without asking anything."
when:
  - "router chose new_fact or fact_update with subject interest"
  - "trigger phrases: I play / I enjoy / I follow / I support / I am into / I watch / I listen to / I collect"
  - "signal: a pastime, a sport, a club, a musician, a genre, a game, a show, a possession or an opinion"
  - "the catch-all: any stated fact that is none of residence, origin, profession or family"
outputs:
  - "one saveExtractedFacts call, one element per distinct interest"
  - "the canonical questionnaire key for the kind of interest it is"
  - "no question in the reply for a plain interest"
---

A pastime, a sport, a team, a musician, a genre, a game. This is also where anything lands that is
none of the other four: an opinion, a possession, a show they watch.

## Do not ask, just offer
A plain interest is complete as stated. "I enjoy playing chess" needs no follow-up: you know what
to do with it. Offer the fact and say one short thing back, with no question mark.

Asking "what do you like about chess" or "do you play competitively" buys nothing. It costs a turn,
and the answer changes no topic you would generate. Ask only where the statement is genuinely
ambiguous between two different subjects, and then use `ask_choice` rather than prose.

## One fact per interest
"I play chess and I follow Formula 1" is two elements, not one. They retrieve entirely separate
news and the user may want one and not the other, which a single card cannot express.

Keep what they said specific. A named team, artist, competition or game is the retrievable part, so
never generalise it away.

- Good: "Plays chess", "Follows Formula 1", "Supports Feyenoord", "Listens to drum and bass".
- Bad: "Enjoys sport", "Likes music", "Has hobbies".

Never attach a place. Their city belongs to their residence fact and the topic run reads both;
stapling it here produces topics about a place they did not mention in this breath.

- Bad: "Plays chess in Amsterdam".

## The attribute key is one of five
There is no single interests key. Pick the one that matches, exactly as written:

| What they stated | `questionnaire_attribute` |
|---|---|
| A pastime or hobby | `hobbies: their hobbies` |
| A sport they play | `sports_playing: sports they play` |
| A team or club they follow | `teams_following: teams + sport` |
| A genre of music, film, games or books | `entertainment_genres: preferred genres` |
| A named artist, creator or public figure | `artists_creators_following: artists/creators they follow` |
| Anything else, including an opinion or a possession | `topics: general interests` |

A sport they PLAY and a team they FOLLOW are different keys even for the same sport. "I play
football" is `sports_playing`; "I support Feyenoord" is `teams_following`; both together are two
elements with two keys.

Copy the key to the character. An invented key matches nothing and the fact stops grouping with its
own kind.

## Checking what is already known
`find_similar_facts` takes `{ kind? }` and nothing else. Pass the kind matching the key above, so
the check runs against interests rather than the whole persona.

- No match: offer as new. Most interests are additive, and a person may hold many.
- Same key, a NARROWER version of something held: "I play blitz chess" against "Plays chess" is a
  refinement. Offer it with `replaces` set and say so in one line.
- Same key, a different interest: NOT a replacement. Chess and Formula 1 coexist. Adding one never
  retires another, and this is the most common mistake here.
- They have stopped: "I do not follow Formula 1 any more" is a deletion, not a negative fact. Route
  it as a correction rather than offering "Does not follow Formula 1".
