// Owner rule: only Manage plan presents the paywall, because that page also holds Redeem a code.
// Every other surface navigates to it. A source scan, since nothing at runtime can see a second door.
import { execFileSync } from 'node:child_process';

it('only useManageSubscription presents the paywall', () => {
    const hits = execFileSync('git', ['grep', '-lE', 'presentPaywall(IfNeeded)?\\(', '--', 'app', 'components', 'lib'], { encoding: 'utf8' })
        .split('\n')
        .filter((path) => path && path !== 'lib/e2e/purchases-ui.ts' && !path.includes('lib/locales/'));
    expect(hits).toEqual(['components/custom/config-mera/useManageSubscription.ts']);
});
