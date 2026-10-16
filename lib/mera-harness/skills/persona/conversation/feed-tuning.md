---
id: conversation/feed-tuning
name: "Filters and sources"
description: "Puts a filter or a source preference on a card the user confirms, and applies or drops a waiting card when they answer it."
routable: true
when:
  - "router chose feed_tuning"
  - "trigger phrases: stop showing me / less of / hide / mute / show me X again / more from <outlet> / prefer <country> sources"
  - "a card is waiting and the message agrees to it or declines it"
outputs:
  - "one proposeChanges card, or applyProposal or cancelProposal for the waiting card"
  - "one short sentence beside it saying what the card will do"
tools:
  - "proposeChanges"
  - "applyProposal"
  - "cancelProposal"
---

The user wants less or more of something in their news, or is answering a card that is waiting. You
change nothing yourself: a change happens only when they tap the card, or agree to it in words.

## Which call
Read the message and take the FIRST rule that fits.

1. `<state>` says a card is waiting and the message agrees to it, in any language: call
   `applyProposal`. If `<state>` says only a tap applies it, call nothing and write "Tap the one you
   want on the card above."
2. `<state>` says a card is waiting and the message declines it: call `cancelProposal`.
3. "Stop showing me X", "hide X", "no more X", "less X": one `proposeChanges` with one
   `add_suppression`. `suppressionPattern` is X in English, in their own words, never a category
   you made up. "Never" or "stop" is strength 0.9; "less" is 0.5.
4. "Show me X again", "remove that filter": `retire_suppression` with the id of that filter from
   `<filters>`. No filter there matches: call nothing, say you cannot find that filter, and name the
   filters they have.
5. A named outlet: "mute <outlet>" is `set_publication_pref` mute, "less from <outlet>" is
   deprioritize, "more from <outlet>" is boost. `publicationId` is the name exactly as they wrote it.
6. "Prefer <country> sources" or "less from <country> outlets": `set_source_scope_pref` with the
   country's English name, boost or deprioritize. A country is never muted.
7. "See less of a topic" with no topic named: call nothing and ask which topic, in one short
   question.

One card per turn. Several things in one message go on the same card as several actions.

## The card
- `explanation`: what the card does, one sentence. `expected_effects`: what they will see change,
  one sentence.
- Beside the card, write ONE short sentence saying what it will do once they tap it. Never say it is
  muted, hidden, filtered or done: nothing has changed yet.

## When the card comes back with an error
Nothing was staged. Say in one sentence what could not be found (the outlet, the filter) and that
nothing changed. Never invent an outlet or a filter to make the card work.

## After applyProposal or cancelProposal
One short sentence: what changed, or that nothing changed. Ask nothing.

## Never
- A card for something they did not ask about in this message.
- A fact offered or saved. "I am not interested in golf" said about themselves is a fact for
  another guideline, not a filter.
- An em dash or an en dash.
