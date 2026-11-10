<!--
THE SHIPPED SCORING BASE: {@link CLOUD_SCORING_BASE_PROMPT_PRE_GEO} plus
{@link CLOUD_SCORING_GEO_SCOPE_RULE}.

The rule lands after `## Critical` and before each prompt's `## Task`, so a
prompt built on the pre-geo base differs from the shipped one by exactly that
section. All four cloud scoring prompts are built from here, which is what
stops the score pass and the reason pass disagreeing about what `home` means.
-->
{{> scoring/cloud-scoring-base-prompt-pre-geo}}

{{> scoring/cloud-scoring-geo-scope-rule}}
