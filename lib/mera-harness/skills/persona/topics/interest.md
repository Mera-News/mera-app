---
id: topics/interest
name: "Interest topics"
routable: false
description: "Turns a hobby, sport, team, artist or genre into global, local and community coverage."
when:
  - "the fact names a pastime, sport, team, artist, genre, game, show or possession"
  - "the fact's attribute key is hobbies, sports_playing, teams_following, entertainment_genres, artists_creators_following or topics"
  - "signal: the statement opens with Plays / Follows / Supports / Listens to / Collects / Watches"
outputs:
  - "a JSON array of 2-to-5-word topic strings, 8 to 10 of them"
  - "the global spine first, then the country and city flavours, then the community side"
examples:
  - "Formula 1 race results"
  - "Formula 1 regulation changes"
  - "Formula 1 driver transfers"
  - "Formula 1 team budget cap"
  - "Formula 1 engine rules 2027"
  - "Dutch Grand Prix Zandvoort"
  - "Max Verstappen contract news"
  - "Formula 1 broadcast rights"
  - "Formula 1 fan attendance"
---

The fact is something the user does or follows. An interest has a real world around it: a top
tier, a governing body, a local scene, a business. Cover all three.

## How many
Emit 8 to 10. This is the one guideline with a FLOOR as well as a ceiling. An interest that returns
three topics is the failure this leaf exists to fix: the user said what they care about and got
almost nothing back. If you are struggling to reach eight, you are describing the interest instead
of naming what gets reported about it.

## Three bands, in this order
**1. The global spine, five or six.** What the wider world of this interest is in the news for.
Its top competition or release cycle, its best-known people, its platforms and products, its
disputes, its governing decisions, its technology.

For a board game that is the world title and the qualifying cycle, the top players, the online
platforms, the cheating rows, the engines and the AI, and the schools programmes. For a sport it is
results, regulations, transfers, budgets and broadcasting. Name the actual subjects, never the
category.

**2. The country and city flavour, two or three.** Read the user's residence fact from the other
facts and localise. The national federation or league, the local clubs and venues, the event their
country actually hosts. If they have no residence fact, skip this band rather than guessing a
country.

**3. The community and business side, one or two.** Streamers and creators, the tournament
calendar, prize money, sponsorship, attendance, rights deals. This is the half that is missed most
often and it is where a lot of the real reporting lives.

## Concrete subjects only
Never "<interest> news", "<interest> updates" or "<interest> community". Those retrieve everything
and therefore nothing. Every topic names a competition, a person, a platform, a rule, an
organisation or an event.

- Bad: "chess news", "chess community", "chess updates", "chess industry trends".
- Good: "chess world championship", "chess cheating investigation", "chess engine research".

A named person is allowed here and only here, because a public figure in a sport or an art form is
what the coverage is actually about. That is the athlete, the champion, the musician. It is never
the user, and never anyone they know.

## Worked example
Fact: "Follows Formula 1"
Other facts: "Lives in Utrecht, Netherlands, Europe"
Existing topics: none

Six global, two local drawn from the residence fact, one business. Nine, inside the 8 to 10 band.

```json
["Formula 1 race results", "Formula 1 regulation changes", "Formula 1 driver transfers", "Formula 1 team budget cap", "Formula 1 engine rules 2027", "Dutch Grand Prix Zandvoort", "Max Verstappen contract news", "Formula 1 broadcast rights", "Formula 1 fan attendance"]
```

Read the bands, not the sport. A fact about a different interest must produce none of these
strings, and must still fill all three bands.

Reply with the JSON array and nothing else. No sentence before it, none after.
