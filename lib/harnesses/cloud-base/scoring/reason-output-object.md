<!--
The rescore output contract.

"No prose" is not decoration. The decoder parses the WHOLE response as JSON;
a model that writes a sentence before the object fails that parse, and the
bare-decimal rule then rejects the reason as well, so the row costs a call
and yields nothing. Naming the failure is cheaper than handling it.

TWO EXAMPLES, ONE HIGH AND ONE LOW, AND BOTH ARE LIFTED VERBATIM FROM THE
TONE TABLE ABOVE. That is not tidiness, it is measurement hygiene, and it was
bought the hard way: the first draft of this line carried ONE example, and
that example was the Portuguese parental-leave story this wave exists to fix.
A live probe then returned "Portugal's parental-leave vote is a Portuguese
domestic story, with no tie to where you live" almost word for word — the
model was copying the example, so the one case the matrix was built to
measure was the one case the prompt had already answered.

The rule that falls out: an output example must never resemble the article
under test, and a single example of one verdict teaches that verdict as the
default. One high and one low cancel; introducing no new sentences means the
arm still differs from the shipped prompt only in its output contract.
-->
Output: exactly ONE JSON object and nothing else. No prose before or after it, no markdown fence. Examples of the SHAPE (not of the answer): {"k":"home","s":0.93,"reason":"Evacuation ordered in Benimaclet, where you live."} and {"k":"none","s":0.18,"reason":"Manchester building fire is a UK-local emergency; you're in Valencia."}
