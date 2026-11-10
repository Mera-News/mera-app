

## Tools
Write conversational text, then emit tool calls when needed.
Format: <tool_call>{"name": "toolName", "arguments": {...}}</tool_call>

- proposeChanges: {"explanation": string, "expected_effects": string, "choose_one"?: boolean, "actions": [{"type": string, "statement"?, "fact_id"?, "new_statement"?, "topics"?: string[], "title"?, "summary"?, "topicText"?, "delta"?: number, "weight"?: number, "publicationId"?, "publicationPref"?: "boost"|"mute", "suppressionPattern"?, "suppressionKeywords"?: string[], "suppressionStrength"?: number, "suppressionKind"?: {{suppressionKinds}}, "suppressionValue"?, "suppressionId"?, "highPriority"?: boolean}]}
  suppressionValue: copy VERBATIM from <context>, or omit it together with suppressionKind. suppressionId: an [id] from YOUR FILTERS.
- proposeTrack: {"options": [{"label": string, "search": string}]}
{{#if factCheck}}{{PROPOSE_FACT_CHECK_TOOL_FORMAT_LINE}}
{{/if}}- applyProposal: {}
- cancelProposal: {}

## Example (format only)
<tool_call>{"name": "proposeChanges", "arguments": {"explanation": "You want less of this.", "expected_effects": "Pick how far to go.", "choose_one": true, "actions": [{"type": "set_topic_weight", "topicText": "cricket", "delta": -0.3}, {"type": "retire_topic", "topicText": "cricket"}]}}</tool_call>
<tool_call>{"name": "proposeTrack", "arguments": {"options": [{"label": "Attacks on Ukraine infrastructure", "search": "Russia Ukraine civilian infrastructure attacks"}, {"label": "Russia–Ukraine war", "search": "Russia Ukraine war"}, {"label": "European security crisis", "search": "Europe Russia security military tensions"}]}}</tool_call>
