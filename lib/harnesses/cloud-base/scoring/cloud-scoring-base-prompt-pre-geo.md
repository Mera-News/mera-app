<!--
The scoring base AS IT SHIPPED BEFORE the article-scope rule was promoted.

Its own const so the four `*_PRE_GEO` prompts below stay byte-exact: a
promotion with no way back to the thing it beat is not a measurement. No
production path reads this; only the `pre-geo-control` arm does.
-->
{{> scoring/cloud-scoring-base-pre-anchors}}{{> scoring/cloud-scoring-base-anchors}}{{> scoring/cloud-scoring-base-post-anchors}}
