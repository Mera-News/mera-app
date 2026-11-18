// The keys of the "your own services" modes must go with every local wipe, and no backup may carry them.
import Constants from 'expo-constants';
import { BACKUP_SETTING_KEYS, BACKUP_TABLES } from '@/lib/backup/allowlist';
import { OWN_AI_KEY, OWN_NEWS_KEY, POD_PAIRING_KEY } from '@/lib/own-services/keys';
import { wipeAllLocalUserData } from '@/lib/security/local-wipe';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { secureStoreDump } from '@/test/helpers';

const slug = Constants.expoConfig?.slug || 'app';
const OWN_KEYS = [OWN_AI_KEY, OWN_NEWS_KEY, POD_PAIRING_KEY];

async function seed(): Promise<void> {
    for (const k of OWN_KEYS) await secureStore.setItemAsync(k, 'secret');
    await secureStore.setItemAsync(`${slug}_cookie`, 'cookie-value');
}

it('names the keys under the app slug', () => {
    expect(OWN_KEYS).toEqual([`${slug}_own_ai`, `${slug}_own_news`, `${slug}_pod_pairing`]);
});

it('a logout wipe leaves none of the keys', async () => {
    await seed();
    await wipeAllLocalUserData();
    for (const k of OWN_KEYS) expect(secureStoreDump()[k]).toBeUndefined();
});

it('an account-switch wipe removes them too and keeps the session cookie', async () => {
    await seed();
    await wipeAllLocalUserData({ keepSession: true });
    for (const k of OWN_KEYS) expect(secureStoreDump()[k]).toBeUndefined();
    expect(secureStoreDump()[`${slug}_cookie`]).toBe('cookie-value');
});

it('backups carry no setting or table of the own-service modes', () => {
    for (const name of [...BACKUP_SETTING_KEYS, ...BACKUP_TABLES]) expect(name).not.toMatch(/own_|pod_/);
});
