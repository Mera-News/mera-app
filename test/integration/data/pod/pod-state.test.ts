import { BACKUP_SETTING_KEYS, BACKUP_TABLES } from '@/lib/backup/allowlist';
import { OwnServiceError } from '@/lib/own-services/gate';
import { POD_PAIRING_KEY } from '@/lib/own-services/keys';
import { forgetPairing, podConfig, podHost, podPaired, podState, savePairing, type PodPairing } from '@/lib/own-services/pod-state';
import { reportSecrets, setReportSecrets } from '@/lib/own-services/report-secrets';
import { wipeAllLocalUserData } from '@/lib/security/local-wipe';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { failSecureStore, fakePod, podPairing, secureStoreDump } from '@/test/helpers';

const TOKEN = 'pod-token-abcdef123456';
const pairing = (over: Partial<PodPairing> = {}): PodPairing =>
  podPairing({ baseUrl: 'https://Pod.Own.Test/', token: TOKEN, pairedAt: 1_700_000_000_000, ...over });

beforeEach(() => podState.resetMemory());
afterEach(() => setReportSecrets('pod', null));

describe('pairing item', () => {
  it('with nothing stored every reader says not paired', async () => {
    await podState.hydrate();
    expect(podPaired()).toBe(false);
    expect(podHost()).toBeNull();
    expect(podConfig()).toBeNull();
  });

  it('is stored under the pairing key and hydrates back after a restart', async () => {
    await savePairing(pairing());
    expect(JSON.parse(secureStoreDump()[POD_PAIRING_KEY]).token).toBe(TOKEN);
    expect(podPaired()).toBe(true);
    expect(podHost()).toBe('pod.own.test');

    podState.resetMemory();
    expect(podPaired()).toBe(false);
    await podState.hydrate();
    expect(podPaired()).toBe(true);
    expect(podConfig()).toEqual(pairing({ baseUrl: 'https://pod.own.test' }));
  });

  it('only an active item pairs the phone; a pending one has no host and no config', async () => {
    await savePairing(pairing({ state: 'pending', pendingAt: 5 }));
    expect(podState.get()?.state).toBe('pending');
    expect(podPaired()).toBe(false);
    expect(podHost()).toBeNull();
    expect(podConfig()).toBeNull();
    await savePairing(pairing());
    expect(podPaired()).toBe(true);
    await forgetPairing();
    expect(podPaired()).toBe(false);
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
  });

  it('an item stored without a confirmation or a state reads as not paired, and cannot be saved', async () => {
    const { confirmed: _c, state: _s, ...old } = pairing();
    await secureStore.setItemAsync(POD_PAIRING_KEY, JSON.stringify(old));
    await podState.hydrate();
    expect(podState.get()).toBeNull();
    expect(podPaired()).toBe(false);
    await expect(savePairing({ ...pairing(), confirmed: undefined as never })).rejects.toMatchObject({ code: 'not-confirmed' });
  });

  it.each([
    ['an http address', { baseUrl: 'http://pod.own.test' }],
    ['a name and password in the address', { baseUrl: 'https://me:pw@pod.own.test' }],
    ['no token', { token: '' }],
    ['another version', { v: 2 }],
  ])('a stored item with %s reads as not paired', async (_n, over) => {
    await secureStore.setItemAsync(POD_PAIRING_KEY, JSON.stringify({ ...pairing(), ...over }));
    await podState.hydrate();
    expect(podPaired()).toBe(false);
    expect(podHost()).toBeNull();
    expect(podConfig()).toBeNull();
    expect(reportSecrets().secrets).toEqual([]);
  });

  it('refuses to save an address that is not https or carries a name', async () => {
    for (const baseUrl of ['http://pod.own.test', 'https://me:pw@pod.own.test']) {
      await expect(savePairing(pairing({ baseUrl }))).rejects.toBeInstanceOf(OwnServiceError);
    }
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
    expect(podPaired()).toBe(false);
  });

  it('gives the report scrub the host and token while paired, and nothing after forget', async () => {
    await savePairing(pairing());
    expect(reportSecrets()).toEqual({ hosts: ['pod.own.test'], secrets: [TOKEN] });
    await forgetPairing();
    expect(reportSecrets()).toEqual({ hosts: [], secrets: [] });
  });

  it('a local wipe tells the server, removes the item, and no backup lists it', async () => {
    const pod = fakePod({ token: TOKEN });
    await savePairing(pairing());
    await wipeAllLocalUserData();
    expect(pod.revoked.has(TOKEN)).toBe(true);
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
    for (const name of [...BACKUP_SETTING_KEYS, ...BACKUP_TABLES]) expect(name).not.toMatch(/pod_/);
  });

  it('a throwing read leaves the state unhydrated and not paired', async () => {
    failSecureStore(POD_PAIRING_KEY, 'get');
    await expect(podState.hydrate()).rejects.toThrow();
    expect(podState.isHydrated()).toBe(false);
    expect(podPaired()).toBe(false);
  });
});
