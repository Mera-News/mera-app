<!--
The promoted rules PLUS the shipped output contract, in the byte-exact order
the rater scored.

The output line has to be restated here and not only in the task block,
because these rules are appended AFTER it and a model reads the last
instruction on a subject as the live one. That is also why the rescore twin
below exists: leaving the "single plain string" line as the final word of a
prompt that asks for a JSON object would quietly undo the object contract.
-->
{{> scoring/reason-v2-rules-body}}

{{> scoring/reason-output-string}}
