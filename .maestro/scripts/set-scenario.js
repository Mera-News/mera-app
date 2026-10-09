// GraalJS: var only, no async/await, no fetch. MOCK and SCENARIO come from the flow env.
var r = http.post(MOCK + '/__control/scenario', {headers: {'Content-Type': 'application/json'}, body: SCENARIO});
if (!r.ok) throw new Error('set-scenario ' + r.status);
