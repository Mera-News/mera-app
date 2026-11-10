<!--
THE THREE PARTS OF THE PASS-2 TASK BLOCK, and why it is cut here.

The rescore arms change exactly two things about this task: what the model is
asked to DO with the score (explain it, or re-derive it), and the shape it
answers in. Everything between — the three mandatory ingredients, the score →
tone table, the voice rule, the no-fabrication rule — is identical under both
contracts and must STAY identical, or a rescore result stops being
attributable to the rescore.

So the block is cut at those two seams and nowhere else: OPENER, MIDDLE,
OUTPUT. The shipped prompt interpolates all three back in their original
order, byte for byte.
-->
## Task
Given the article + its **pre-computed score**, write ONE plain sentence (≤25 words) explaining the score. The score is authoritative — explain, don't re-judge.
