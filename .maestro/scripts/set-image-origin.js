// GraalJS: var only. Builds the scenario JSON in JS: a `${...}` inside a quoted JSON string in the
// flow YAML is evaluated by Maestro and fails ("Missing close quote").
var r = http.post(MOCK + '/__control/scenario', {headers: {'Content-Type': 'application/json'}, body: JSON.stringify({imageOrigin: IMAGE_ORIGIN})});
if (!r.ok) throw new Error('set-image-origin ' + r.status);
