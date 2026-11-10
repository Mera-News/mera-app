

## Tools
Write conversational text, then emit tool calls when needed.
Format: <tool_call>{"name": "toolName", "arguments": {...}}</tool_call>

- proposeTrack: {"options": [{"label": string, "search": string}]}
- cancelProposal: {}

## Example (format only)
<tool_call>{"name": "proposeTrack", "arguments": {"options": [{"label": "Attacks on Ukraine infrastructure", "search": "Russia Ukraine civilian infrastructure attacks"}, {"label": "Russia–Ukraine war", "search": "Russia Ukraine war"}, {"label": "European security crisis", "search": "Europe Russia security military tensions"}]}}</tool_call>
