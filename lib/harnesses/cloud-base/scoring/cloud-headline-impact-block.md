<!--
---------------------------------------------------------------------------
HEADLINE variants — AUTHORED IN P4a, ROUTED SINCE P4b.

The "nothing routes to these yet" note that stood here was true for exactly
one wave and then went stale. `article-pipeline/scoring.ts::resolveScoringVariant`
picks the headline pair for a bundle whose candidates are all headline-sourced,
and the routing is pinned by `__tests__/golden-prompts.test.ts`. Editing these
changes production.

A top headline arrives for a different reason than every other article the
scorer sees: it was NOT retrieved because it matched one of the user's
topics, it is here because the world is treating it as major news. The
legacy two-pass prompts have no way to say "this does not match anything you
care about, and it still changes what you pay for petrol" — so a genuinely
consequential headline scores `none` on the same rules that (correctly) kill
foreign-domestic noise.

These variants add exactly ONE extra route to FEED — an indirect causal chain
event → channel → household — and fence it in four ways, because the failure
mode of this feature is not missing a story, it is turning the feed into a
hedging machine that finds "global implications" in everything:
  1. a CLOSED channel list (a chain that can't name one is not a chain),
  2. an EXPOSURE gate on each channel read off [User facts],
  3. a MAGNITUDE test against the absorbing economy's size and buffers,
  4. a GROUNDING rule: the mechanism must be stated in the article's text.

The block below is shared verbatim by the score pass and the reason pass, and
both are built on CLOUD_SCORING_BASE_PROMPT, so tiers, the FEED gates, the
anchor table and the `{"k","s"}` output contract cannot drift from the live
prompts. NOTE: no new `k` value is introduced. A chain that holds terminates
at the user's household, so it is tagged `home` — which the decoder already
band-clamps to [0.40, 1.10] (STAKE_SCORE_BANDS in article-pipeline/scoring.ts).
An invented tag would skip clampToStakeBand entirely and lose the very band
discipline the magnitude test exists to enforce.
---------------------------------------------------------------------------

The headline-only indirect-impact rubric. Appended to CLOUD_SCORING_BASE_PROMPT
in BOTH headline prompts (never retyped) so the score pass and the reason pass
cannot disagree about what a valid chain is.

DESIGN NOTE (for humans — do NOT explain to the model): this block deliberately
suspends two of the base's Hard rules ("Do NOT bridge via … global implications
… forbidden" and "No holdings ⇒ no market relevance") under four simultaneous
conditions. The suspension is named explicitly rather than left to
later-instruction-wins ordering: the base states those rules earlier and more
absolutely, and a model that follows the base faithfully will otherwise
no-op this whole feature. The exposure gate is what keeps the second
suspension narrow — equity_markets/gold stay unavailable to a user with no
holdings, so the no-holdings rule is carved, not repealed.
-->
## Headline override — indirect impact (this batch only)

Every article in this batch is a TOP HEADLINE. It is NOT here because it matched one of the user's topics — it is here because it is major news. So the usual question ("does this match their life?") misses one real case: an event with no direct stake can still change what this user pays, earns, or can do, through a CAUSAL CHAIN — event → channel → their household.

For headline articles ONLY, that chain is a fifth route to FEED, in addition to Step 2's five stakes. It SUSPENDS exactly two of the Hard rules above — "Do NOT bridge via … 'global implications' … these produce phantom relevance and are forbidden" and "No holdings ⇒ no market relevance" — and only when ALL FOUR of these hold:
(a) the chain runs through one of the named channels below (closed list),
(b) [User facts] show this user is actually exposed to that channel,
(c) the chain passes the magnitude test, and
(d) the mechanism is stated in the ARTICLE'S OWN TEXT.
If any one of the four fails, both suspended rules apply again in full and unchanged. Every OTHER Hard rule — foreign-domestic, origin ≠ residence, place-keyword-alone, digests and junk, island/metro radius — stands untouched, for headlines and everything else.

### Impact channels (CLOSED LIST)
fuel_prices · food_prices · power_tariffs · electricity_supply · currency · interest_rates · job_market · export_demand · supply_chain · shipping_costs · travel_disruption · visa_immigration · insurance_costs · medicine_supply · internet_connectivity · housing_costs · taxes_and_subsidies · equity_markets · gold

Name the channel before you score. If no channel on this list fits, there is no chain — drop the override and score the article on Steps 2–4 exactly as written. Never invent a channel, and never substitute a vague phrase for one: "economic impact", "geopolitical consequences", "ripple effects", "market uncertainty", "knock-on effects" are NOT channels — they are the phantom relevance the Hard rules forbid, wearing a new coat.

### Exposure gate (a channel counts only if the user is exposed to it)
- **equity_markets, gold** — require investments listed in [User facts]. With no investments they are UNAVAILABLE and "No holdings ⇒ no market relevance" stands: a market move is EXCLUDE, exactly as before.
- **job_market, export_demand** — require a profession, employer, or venture in the sector the article is about.
- **visa_immigration** — requires a stated migration, permit, citizenship, or cross-border family situation.
- **travel_disruption** — requires an active trip, or a route the user or their family actually travels, AND the disruption must sit ON that route or AT that destination. A different city or region of the destination country is NOT the route (a flood in southern Germany is not a Berlin trip). Airspace, an airport, or a road the journey does not pass through is NOT the route — a short intra-European trip is untouched by airspace closures on another continent, however serious. If you cannot say which leg of a trip the user actually takes is disrupted, this channel FAILS.
- **interest_rates, housing_costs** — require a mortgage, loan, rent, or property in [User facts].
- **fuel_prices, food_prices, power_tariffs, electricity_supply, currency, supply_chain, shipping_costs, insurance_costs, medicine_supply, internet_connectivity, taxes_and_subsidies** — every household in the affected country is exposed; the magnitude test alone decides.
The chain must land in a country the user actually lives in or is going to. A shock reaching "households" in a country the user has no residence, trip, or family in reaches nothing. And the ARTICLE must be about the event reaching THAT country: when an article reports a cost, shortage, or price rise for ANOTHER country's consumers, that is that country's domestic news, and re-aiming it at the user's country is your own invention, not the article's claim — EXCLUDE. Only when the article itself names a cross-border mechanism (a traded essential, a shared market, an EU-wide rule) does a foreign-datelined event land here.

### Magnitude test (shock size RELATIVE to the absorbing economy)
Weigh (1) how big the event is — what share of a traded essential's supply, capacity, or route it removes, halts, or adds, and for how long — against (2) the size, diversification and buffers of the economy that has to absorb it before it reaches this user: total output, how much of that input it actually imports, reserves, subsidies and price caps, substitutes, and how tightly it is coupled to the affected source.
- A LARGE shock landing on a SMALL, undiversified, tightly-coupled economy with no buffers propagates: it reaches households in weeks.
- A SMALL shock landing on a LARGE, diversified, buffered economy does NOT propagate. It is absorbed before it reaches any household — no matter how loud the headline, how many countries are named, or how serious the event is in its own place.
- Too small to propagate (absorbed): one government's statement, threat, or warning; one company's results, layoffs, or investment; a modest tariff or royalty on a substitutable, exchange-traded good; a stalled negotiation; a single-digit-percent move in one commodity; another country's domestic budget or election.
- Large enough to test: a closed or credibly threatened chokepoint carrying a large share of a traded essential; sanctions on a top-three global supplier of one; a currency or banking crisis in a major trading partner; war involving a major producer of something the user's country imports; a harvest failure across a leading exporter of a staple.
- **Hop count is evidence.** Event → channel → household is two hops. If you need a third hop to reach this user, the effect has already been absorbed on the way: that is EXCLUDE.

### Grounding (the mechanism comes from the article, not from memory)
The article itself must state the thing that makes the chain work — a volume, a share, a route, a duration, a halt, a price move, a quantity. If you are supplying that fact from your own knowledge because the article does not state it, the chain is not grounded and the answer is EXCLUDE. Quote the mechanism to yourself in the article's own terms before you score.

### The escape hatch — this is the NORMAL answer
Most top headlines do not affect most people. If the event is too small to propagate, or the user is not exposed to the channel, or the chain needs a third hop, or the article does not state the mechanism, then this is Step 4: tag `"none"`, score 0.05–0.24, and say plainly that it does not affect them. A hedged "may indirectly influence" is a WRONG answer, not a safe one — hedging IS the failure mode here. Say "this does not affect you" and move on.
When the chain DOES hold, the article is a Home stake — the chain terminates at this user's household — so tag it `"home"` and score it with the FEED gates: 0.40–0.59 a real but slow, partly-buffered effect; 0.60–0.79 an effect they will see in their costs or work within weeks. **An indirect chain never exceeds 0.79.** The bands above it are reserved for a DIRECT change to this user's own work, home, or family (0.80–0.94) and for immediate danger where they or their family are, requiring action today (0.95+) — a price or supply effect arriving through a chain, however large the event, does not outrank a flood in their family's city.

### Worked examples (the example user of the anchor table above: Amsterdam, AI news app, family in Bhopal, Berlin trip, NO investments, no mortgage stated)
**POSITIVE — chain holds.** "Strait of Hormuz closure threatened after strikes; the article states a fifth of the world's seaborne oil and roughly a third of LNG pass through it daily, and that tanker traffic has already halved." Channel: fuel_prices, then food_prices (freight and fertiliser price off diesel). Exposure: universal-household channels, and he lives in the Netherlands. Magnitude: a fifth of seaborne oil is a large share of a traded essential; Dutch pump, heating and freight costs price off the same market and there is no substitute at that volume. Grounding: the transit share and the halved traffic are in the article. Two hops. → `{"k":"home","s":0.72}` — "A fifth of the world's seaborne oil passes Hormuz, so a closure raises what you pay at the pump and for heating in Amsterdam."
**NEGATIVE — chain does NOT hold, and this is the more common verdict.** "Chile's congress approves a 3% royalty rise on copper concentrate exports; miners warn of reduced investment." The tempting chain is copper → electronics and construction costs → his prices in Amsterdam. It fails on three of the four gates: magnitude — 3% on one country's royalty is a small move in a deeply supplied, substitutable, exchange-priced metal that a large diversified European economy absorbs entirely; hops — it needs three to reach him; grounding — the article states no volume, price move, or supply halt, only a warning. equity_markets is unavailable: he lists no investments, so "no holdings ⇒ no market relevance" stands. → `{"k":"none","s":0.13}` — "Chile's copper royalty is a small change in a well-supplied global market; it does not affect your costs in Amsterdam."
**NEGATIVE — a travel story that is not HIS travel.** "Europe's aviation regulator advises airlines against flying in airspace over Qatar and the UAE after new attacks on Iran." The tempting chain is aviation → flight costs and delays → his Berlin trip. It fails on exposure: travel_disruption needs the disruption to sit on a route he actually takes, and Amsterdam→Berlin is an hour inside Europe that never enters Gulf airspace. That the story is about flights, and that he has a trip, is NOT the same as his flight being disrupted. Naming a real closed-list channel does not excuse you from asking WHICH LEG of HIS journey stops working — if you cannot name one, the channel failed. → `{"k":"none","s":0.11}` — "Airlines are avoiding Gulf airspace, which your Amsterdam–Berlin trip never crosses; this changes nothing for you."
