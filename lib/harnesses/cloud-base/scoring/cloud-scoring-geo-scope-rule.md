<!--
The geography rule. SHIPPED IN THE BASE, promoted in geofix2.

WHAT IT IS FOR. A Diário de Notícias story about Portugal's parental-leave
vote scored HIGH for a reader living in the Netherlands, with the reason
"Parliament's delay on parental leave directly affects your upcoming March
birth in the Netherlands." Every ingredient of that sentence is in the facts;
the only thing wrong is the country, and no rule in the base says a `home`
stake needs one. The base tells the model to resolve places and not to let
the publication's country override an explicit location, which is a rule
about PRECEDENCE — it never states the floor underneath it.

Measured n=9 before this existed: with the `Article Country` line AND the
residence fact in the prompt, pass 1 still emitted `k:"home"` 6 times out of
9. So the country reaching the model was never the gap.

WHAT IT ACTUALLY BOUGHT, goldset-348 x 3 against a within-run null floor of
0.017 precision / 0.010 recall: broad-set recall 0.406 -> 0.459 at flat
precision (+27 true positives for +8 false), and 8 of 9 DN cells below the
gate with the Dutch control still HIGH 3 of 3. It did NOT reduce `home`
tagging (+2 against a floor of 1); the mass it moved came out of `interest`
(-64) into `none` (+29) and `domain` (+33, floor 11). `domain` is FEED-band,
so the permitted-tag LIST partly reads as a menu. A restriction stated
without enumerating the alternatives is the untested next shape.

Shared by BOTH passes because it is part of the base, which is what stops the
score pass and the reason pass disagreeing about what a `home` story is.
-->
## Article scope
When the title and description name no location, the article is about the publication's country (the `Article Country` / `Publication` lines). A story about a country that appears in none of the user's facts can be `domain`, `attend`, `travel`, `interest` or `none`, but never `home` or `family`: those two require the story's country to be one the user lives in or has family in. A parental-leave vote in Portugal is not a Dutch reader's `home` story, however closely the subject matches their life.
