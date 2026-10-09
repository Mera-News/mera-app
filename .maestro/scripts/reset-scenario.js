// GraalJS: var only. Every top-level flow starts here so a scenario set by an earlier flow
// (the mock server lives for the whole run) never leaks into the next one.
var r = http.post(MOCK + '/__control/reset', {headers: {'Content-Type': 'application/json'}, body: '{}'});
if (!r.ok) throw new Error('reset-scenario ' + r.status);
