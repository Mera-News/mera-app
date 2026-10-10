// The E2E build's stubbed paywall (lib/e2e/purchases-ui.ts) asks this route what to resolve to,
// so a flow scripts a purchase through the scenario. Shared with Jest like every other handler.
import { http, HttpResponse } from 'msw';
import { getScenario, setScenario } from './scenario';

export const paywallHandlers = [
  http.post('*/__e2e/paywall', () => {
    const { result } = getScenario().paywall;
    if (result === 'PURCHASED') setScenario({ purchasedAt: Date.now() });
    return HttpResponse.json({ result });
  }),
];
