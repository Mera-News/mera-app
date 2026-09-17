# mera-harness

The persona agent: a bounded tool-calling loop, the skills it loads, and the eval that scores it.

Self-contained by construction. **No React, no React Native, no Expo, no WatermelonDB, no Zustand,
no Apollo, no network.** Everything the loop needs from the device arrives through injected ports,
so this folder can be lifted into its own package without untangling it from the app.

`__tests__/boundary.test.ts` enforces that over the whole folder, not just one entry file, and
carries a negative control so a broken detector cannot read green.

## Layout

| Path | What | Owner |
|---|---|---|
| `core/` | the loop, tool contracts, turn state, similarity, skill loader, topic call | agent |
| `skills/` | skill markdown, the generator, the generated module | skills |
| `eval/` | scoring, fixtures, the `ModelCaller` port | eval |
| `index.ts` | the public surface. Import from `@/lib/mera-harness`, never from a file inside | |

Consumers live **outside**: the RN driver (`lib/hooks/useCloudPersonaChat.ts`), the DB-backed tool
port, the UI, and `place-service` (which imports `Bloc` from here and owns the country map).
`harness-local` supplies NEAR, the staging rail and the JSONL sink to the eval, and nothing here
imports it.

## One turn

```
user message
     │
     ▼
┌─ leg 1 ─────────────────────────────────────────────┐
│ system: router prompt (identity, voice, tool list,  │
│         skill index, decision procedure)            │
│ user:   <state> one line the loop wrote             │
│         <known_facts>                               │
│         the user's message                          │
│                                                     │
│ model:  "Alkmaar, let me note that."  ← streams NOW │
│         + load_skill("facts/residence")             │
└─────────────────────────────────────────────────────┘
     │  a forcing tool ran, so continue
     │  the loaded body becomes the NEXT system prompt
     ▼
┌─ leg 2 ─────────────────────────────────────────────┐
│ system: facts/generic + facts/residence (composed)  │
│ user:   state line, known facts, the message,       │
│         + this turn's tool results                  │
│ model:  lookup_place("Alkmaar")                     │
│         find_similar_facts(kind:"residence")        │
└─────────────────────────────────────────────────────┘
     │
     ▼
┌─ leg 3 ─── saveExtractedFacts(...) ── settles ──────┘
     │
     ▼  on accept, one queued job per fact
┌─ topic call (terminal, SMALL model) ────────────────┐
│ system: topics/generic + topics/residence           │
│ user:   the fact, other facts, exclusions           │
│ → a JSON array, then nothing                        │
└─────────────────────────────────────────────────────┘
```

Four things about that diagram are load-bearing:

- **The acknowledgement streams in leg 1, before the tool call.** First prose therefore arrives at a
  single leg's latency even though the turn runs three. The `forced` check runs *before* the settled
  branch, so a leg carrying text **and** a forcing call continues; reverse those two and every fact
  turn becomes one leg with no skill loaded.
- **No chat history on any leg.** The state line carries what the loop established. It is not merely
  cheaper than a history window, it is more reliable: it cannot be truncated mid-pair.
- **A loaded skill becomes the next leg's system prompt**, not a tool result read back.
- **`ask_choice` ends the turn.** The chips render, the tap arrives as the next user message, and
  the chosen option's *structured payload* is carried in turn state so nothing is looked up twice.

## Adding a tool

1. Declare it in `core/tool-contracts.ts` and add it to `HARNESS_TOOLS`.
2. Decide continuation. In `CONTINUATION_TOOLS` means "the result is the point, run another leg".
   Leave it out only if the tool **ends** the turn, as `ask_choice` does.
3. Add the method to `AgentToolPort` in `core/types.ts` if it touches the device. Keep arguments
   minimal: **tool arguments sit outside the E2EE envelope**, so never send text the device already
   has. `find_similar_facts` takes no statement for exactly this reason.
4. Handle it in the `for (const call of result.toolCalls)` block in `core/core.ts`.
5. Implement the port method in the app, and a fake in `eval/`.
6. If it can destroy data, gate it on `turn.resolvedChoice` the way `deleteUserFacts` is. "A question
   was asked" is not consent.

## Adding a skill

1. Write `skills/persona/<group>/<kind>.md` with frontmatter (`id`, `description`, `when`).
2. Every group needs a `generic.md`. The loader **composes** it ahead of each leaf, so shared rules
   are written once; a leaf loads as generic + leaf, a generic loads alone.
3. Regenerate the module, then run the tests. The generic preamble must carry the `## Output`
   contract — it is the only structural check the loader makes.
4. Routable skills appear in the router index automatically. `<group>/generic` is excluded, because
   a preamble is composed, never chosen.

## Running

```bash
npx jest lib/mera-harness              # everything here, including the e2e and the boundary test
npx jest lib/mera-harness/__tests__/e2e   # just the end-to-end conversations
npx tsc --noEmit
```

The e2e drives `runAgentTurn` through three production conversations with a scripted fake model and
fake ports: a residence move, an ambiguous place resolved by a tap on the following turn, and a
correction whose delete is refused until confirmed. No network, so it runs in CI.

The eval hits real models and costs money; it lives behind a `ModelCaller` port and is driven from
`harness-local`, never from jest.

## Two numbers worth knowing before you change them

**`FILTER_DROP_JACCARD = 0.75`** (`core/topic-similarity.ts`). The near-duplicate filter drops at
0.75 and never on a subset; the eval scorer flags at `DETECT_JACCARD = 0.6` or on a subset. The gap
is deliberate: were they equal, the duplicate gate would measure its own filter and read clean by
construction. Place names are excluded from the token set when the fact has a resolved place chain,
and with no chain the set is empty, which inflates similarity — measured, the worst ladder pairs then
score 0.25 and 0.667, both safely under 0.75. **At 0.6 the second pair dies and it is a legitimate
ladder rung**, so lowering the threshold means re-deriving those numbers first. A test pins both.

**`MAX_TOPICS_PER_FACT = 12`** is a safety valve, not a target. The count per fact kind lives in the
skill body, and there is **no per-persona ceiling**.
