// Pairing a phone with its own server: the erase, the order that keeps a failed pairing harmless, the boot rule
// for a leftover item, and the pairing link. The server is the fake one; everything else is real.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));
jest.mock('expo-updates', () => ({ isEnabled: true, reloadAsync: jest.fn(async () => undefined) }));

import fs from 'node:fs';
import path from 'node:path';
import * as Device from 'expo-device';
import * as Sentry from '@sentry/react-native';
import * as Updates from 'expo-updates';
import { sanitizedRaw } from '@nozbe/watermelondb/RawRecord';

import { __resetAppRestartForTests, RESTART_MARKER_KEY } from '@/lib/app-restart';
import { watermelonRowSink } from '@/lib/backup/adapters/watermelon-row-sink';
import database from '@/lib/database';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { APP_KEEP_SETTING_KEYS, ERASED_ON_PURPOSE, appKeepSettingKeys } from '@/lib/own-services/erase-keep';
import { OwnServiceError } from '@/lib/own-services/gate';
import { POD_PAIRING_KEY } from '@/lib/own-services/keys';
import { ownAiOn, ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsOn, ownNewsState } from '@/lib/own-services/own-news-state';
import { parsePairLink, setPendingPairLink, takePendingPairLink } from '@/lib/own-services/pending-pair-link';
import { PodError } from '@/lib/own-services/pod-client';
import { pairAndErase, settlePendingPairing } from '@/lib/own-services/pod-pairing';
import { leavePodMode } from '@/lib/own-services/pod-runner';
import { forgetPairing, podConfig, podPaired, podState, type PodPairing } from '@/lib/own-services/pod-state';
import { setReportSecrets } from '@/lib/own-services/report-secrets';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { platform } from '@/lib/platform';
import { COMMAND_REGISTRY_VERSION } from '@/lib/sync/command';
import { PAIRING_ERASED_KEY, PAIRING_KEEP_SETTING_KEYS, isSyncSettingKey } from '@/lib/sync/tables';
import { fakePod, HttpResponse, http, podSnapshotFrom, POD_URL, secureStoreDump, server, setAppState, useFakeClock } from '@/test/helpers';
import { resetScheduler } from '../scheduler/core/support';

jest.setTimeout(60_000);

const CODE = 'K7Q2M9XD';
const CONFIRMED = { at: 1_700_000_000_000, privacyVersion: 'v7' };
const SERVER_FACT = 'PLANTED-SNAPSHOT-MARKER lives in Utrecht';
const TABLES = () => Object.keys(database.schema.tables);

let pod: ReturnType<typeof fakePod>;
let logs: jest.SpyInstance[];
const reload = Updates.reloadAsync as jest.Mock;

/** Every row of every table, raw, in a stable order: what "exactly as it was" compares. */
async function dump(): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES().sort()) {
    const rows = await database.get(table as never).query().fetch();
    out[table] = rows.map((r) => ({ ...(r as unknown as { _raw: object })._raw })).sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
  }
  return JSON.stringify(out);
}

const ids = async (table: string) => (await database.get(table as never).query().fetch()).map((r) => r.id).sort();

const KEPT_VALUES: Record<string, string> = {};
const ERASED_VALUES: Record<string, string> = { ...Object.fromEntries(ERASED_ON_PURPOSE.map((k) => [k, `phone-${k}`])), zz_a_new_key: 'x' };

async function seedPhone() {
  const raw = (table: string, row: Record<string, unknown>) =>
    database.write(async () => {
      const col = database.get(table as never);
      await col.create((rec: any) => {
        rec._raw = sanitizedRaw({ ...row, _status: 'created', _changed: '' }, col.schema);
      });
    });
  await watermelonRowSink.createRows('facts', [{ id: 'phone-fact-1', statement: 'PHONE-FACT', created_at: 1, updated_at: 1 }]);
  await raw('conversations', { id: 'conv-1', surface: 'chat', created_at: 1 });
  await raw('messages', { id: 'msg-1', conversation_id: 'conv-1', role: 'user', content: 'PHONE-CHAT', created_at: 1 });
  await raw('notifications', { id: 'note-1', type: 'tip', title: 't', body: 'b', status: 'unread', source: 'local', created_at: 1 });
  await raw('user_personas', { id: 'persona-1', server_id: 'srv-1', user_id: 'user-1', processing_mode: 'cloud', onboarding_stage: 'done', created_at: 1, updated_at: 1 });
  const keep = [...PAIRING_KEEP_SETTING_KEYS, ...(await appKeepSettingKeys()), 'tutorial_chapter_intro_completed'].filter(
    (k) => k !== 'js_restart_marker' && k !== 'onboarding_done',
  );
  for (const key of new Set(keep)) {
    KEPT_VALUES[key] = `phone-${key}`;
    await setSetting(key, `phone-${key}`);
  }
  for (const [key, value] of Object.entries(ERASED_VALUES)) await setSetting(key, value);
  await setSetting('onboarding_done', 'false');
  await setSetting('app_language', 'nl');
  await setSetting('feed_card_state_v1', '{"phone":1}');
}

async function serveSnapshot() {
  pod.snapshot = await podSnapshotFrom(async () => {
    await watermelonRowSink.createRows('facts', [{ id: 'server-fact-1', statement: SERVER_FACT, created_at: 1, updated_at: 1 }]);
    await watermelonRowSink.createRows('article_suggestions', [{ id: 'server-article-1' }]);
    await setSetting('app_language', 'de');
  });
}

const ownServicesOn = async () => {
  await ownAiState.save({
    v: 1, baseUrl: 'https://ai.own.test/v1', model: 'm1', key: 'ai-key-12345678', on: true, checkedAt: 1, status: 'connected', confirmed: CONFIRMED,
  });
  await ownNewsState.save({
    v: 1, baseUrl: 'https://news.own.test', key: 'news-key-12345678', on: true, checkedAt: 1, status: 'connected', fields: null, confirmed: CONFIRMED,
  });
};

const pairInput = { baseUrl: POD_URL, code: CODE };
const fail = async (p: Promise<unknown>): Promise<any> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to fail');
};
const sent = (path: string) => pod.requests.filter((r) => r.path === path);

/** Pairs with updates on, as a real build would, so the restart can be seen. */
async function pairWithRestart(confirmation: typeof CONFIRMED | undefined = CONFIRMED) {
  (global as { __DEV__?: boolean }).__DEV__ = false;
  try {
    await pairAndErase(pairInput, confirmation);
  } finally {
    (global as { __DEV__?: boolean }).__DEV__ = true;
  }
}

beforeEach(async () => {
  resetScheduler();
  resetBreaker();
  __resetAppRestartForTests();
  reload.mockClear();
  podState.resetMemory();
  ownAiState.resetMemory();
  ownNewsState.resetMemory();
  await Promise.all([podState.hydrate(), ownAiState.hydrate(), ownNewsState.hydrate()]);
  setAppState('active');
  pod = fakePod();
  logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  (Sentry.addBreadcrumb as jest.Mock).mockClear();
  (Sentry.captureException as jest.Mock).mockClear?.();
  await serveSnapshot();
  await seedPhone();
});

afterEach(async () => {
  await leavePodMode();
  await forgetPairing();
  AppScheduler.dispose();
  setReportSecrets('pod', null);
  logs.forEach((s) => s.mockRestore());
});

describe('a good pairing', () => {
  it('erases what the phone held, shows what the server holds, keeps the account, and restarts', async () => {
    const before = Object.fromEntries(
      (await database.get('user_personas').query().fetch()).map((r) => [r.id, JSON.stringify((r as unknown as { _raw: object })._raw)]),
    );

    await pairWithRestart();

    expect(await ids('facts')).toEqual(['server-fact-1']);
    expect(await ids('article_suggestions')).toEqual(['server-article-1']);
    expect(await ids('conversations')).toEqual([]);
    expect(await ids('messages')).toEqual([]);
    expect(await ids('notifications')).toEqual([]);
    const after = Object.fromEntries(
      (await database.get('user_personas').query().fetch()).map((r) => [r.id, JSON.stringify((r as unknown as { _raw: object })._raw)]),
    );
    expect(after).toEqual(before);

    for (const [key, value] of Object.entries(KEPT_VALUES)) {
      if (key === 'app_language' || key === 'mera_skip_notes') continue;
      expect([key, await getSetting(key)]).toEqual([key, value]);
    }
    for (const key of Object.keys(ERASED_VALUES)) expect([key, await getSetting(key)]).toEqual([key, null]);
    expect(await getSetting('feed_card_state_v1')).toBeNull();
    expect(await getSetting('app_language')).toBe('de');
    expect(await getSetting('onboarding_done')).toBe('true');
    expect(Number(await getSetting(PAIRING_ERASED_KEY))).toBeGreaterThan(0);

    const item = podState.get() as PodPairing;
    expect(item).toMatchObject({ state: 'active', baseUrl: POD_URL, confirmed: CONFIRMED, podName: 'Home pod' });
    expect(podPaired()).toBe(true);
    expect(podConfig()?.token).toBe(item.token);
    expect(JSON.parse(secureStoreDump()[POD_PAIRING_KEY]).state).toBe('active');
    expect(pod.requests.map((r) => r.path)).toEqual(['/pair', '/snapshot']);
    expect(sent('/snapshot')[0].headers.authorization).toBe(`Bearer ${item.token}`);
    expect(sent('/snapshot')[0].body.hashes).toEqual({});

    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await getSetting(RESTART_MARKER_KEY)) as string).reason).toBe('pair');
  });

  it('names the device by its model, never by its personal name', async () => {
    await pairWithRestart();
    expect(sent('/pair')[0].body.deviceName).toBe(Device.modelName ?? 'Phone');
    expect(Object.keys(sent('/pair')[0].body).sort()).toEqual(['code', 'deviceName']);
  });

  it('turns own AI and own news off after the erase, with their addresses kept', async () => {
    await ownServicesOn();
    await pairWithRestart();
    expect(ownAiOn()).toBe(false);
    expect(ownNewsOn()).toBe(false);
    expect(ownAiState.get()?.baseUrl).toBe('https://ai.own.test/v1');
    expect(ownNewsState.get()?.baseUrl).toBe('https://news.own.test');
  });
});

describe('a pairing that does not happen leaves the phone exactly as it was', () => {
  const unchanged = async (before: string) => {
    expect(await dump()).toBe(before);
    expect(podState.get()).toBeNull();
    expect(podPaired()).toBe(false);
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(await getSetting(RESTART_MARKER_KEY)).toBeNull();
    expect(ownAiOn()).toBe(true);
    expect(ownNewsOn()).toBe(true);
  };

  beforeEach(ownServicesOn);

  it.each([
    ['wrong_code', () => fakePod(), 'NOPE0000'],
    ['pairing_closed', () => fakePod({ pairing: { closed: true } }), CODE],
    ['already_paired', () => fakePod({ pairing: { alreadyPaired: true } }), CODE],
  ])('%s throws, sends nothing else and revokes nothing', async (code, make, typed) => {
    pod = make();
    const before = await dump();
    const err = await fail(pairAndErase({ baseUrl: POD_URL, code: typed }, CONFIRMED));
    expect(err).toBeInstanceOf(PodError);
    expect(err.code).toBe(code);
    expect(sent('/devices/revoke')).toEqual([]);
    expect(sent('/snapshot')).toEqual([]);
    await unchanged(before);
  });

  it('the sixth try in a minute is too_many_tries', async () => {
    const before = await dump();
    for (let i = 0; i < 5; i++) expect((await fail(pairAndErase({ baseUrl: POD_URL, code: 'NOPE0000' }, CONFIRMED))).code).toBe('wrong_code');
    expect((await fail(pairAndErase(pairInput, CONFIRMED))).code).toBe('too_many_tries');
    await unchanged(before);
  });

  it('without a confirmation nothing is sent and nothing is stored', async () => {
    const before = await dump();
    const err = await fail(pairAndErase(pairInput, undefined));
    expect(err).toBeInstanceOf(OwnServiceError);
    expect(err.code).toBe('not-confirmed');
    expect(pod.requests).toEqual([]);
    await unchanged(before);
  });

  it.each(['http://pod.own.test', 'https://me:pw@pod.own.test', 'pod.own.test'])('an address of %s is refused before anything is sent', async (baseUrl) => {
    const before = await dump();
    expect((await fail(pairAndErase({ baseUrl, code: CODE }, CONFIRMED))).code).toBe('address');
    expect(pod.requests).toEqual([]);
    await unchanged(before);
  });

  const failSnapshot = async (code: string) => {
    const before = await dump();
    const err = await fail(pairAndErase(pairInput, CONFIRMED));
    expect(err).toBeInstanceOf(PodError);
    expect(err.code).toBe(code);
    expect(pod.revoked.size).toBe(1);
    const [revoked] = [...pod.revoked];
    expect(sent('/devices/revoke')[0].headers.authorization).toBe(`Bearer ${revoked}`);
    await unchanged(before);
  };

  it('the server unreachable at the first snapshot: revoked with the new token, nothing changed', async () => {
    server.use(http.post(`${POD_URL}/snapshot`, () => HttpResponse.error()));
    await failSnapshot('unreachable');
  });

  it('the server failing at the first snapshot', async () => {
    pod.answer('/snapshot', 500);
    await failSnapshot('failed');
  });

  it('a version mismatch at the first snapshot says which side is older', async () => {
    pod.versions.registry += 1;
    await failSnapshot('phone-old');
  });

  it('a server on an older version than the phone says so', async () => {
    pod.versions.schemaVersion -= 1;
    await failSnapshot('server-old');
  });

  it('a snapshot the apply refuses (a repeated row id) changes nothing', async () => {
    pod.snapshot.tables.facts = { ...pod.snapshot.tables.facts, rows: [{ id: 'dup', statement: 'a' }, { id: 'dup', statement: 'b' }] };
    await failSnapshot('failed');
  });

  it('a snapshot with no rows for a served table is refused before anything is erased', async () => {
    delete (pod.snapshot.tables.locations as { rows?: unknown }).rows;
    await failSnapshot('failed');
  });

  it('a snapshot from another schema is refused', async () => {
    pod.snapshot = { ...pod.snapshot, schemaVersion: pod.snapshot.schemaVersion + 1, registry: COMMAND_REGISTRY_VERSION };
    await failSnapshot('phone-old');
  });
});

describe('a leftover pending item at boot', () => {
  const TOKEN = 'pod-token-pending-0123456789';
  const pending = (over: Partial<PodPairing> = {}): PodPairing => ({
    v: 1, baseUrl: POD_URL, deviceId: 'device-9', token: TOKEN, podName: 'Home pod', pairedAt: 5_000,
    confirmed: CONFIRMED, state: 'pending', pendingAt: 5_000, ...over,
  });

  beforeEach(async () => {
    pod.tokens.add(TOKEN);
    await podState.save(pending());
  });

  it('is not paired while it is pending', () => {
    expect(podPaired()).toBe(false);
    expect(podConfig()).toBeNull();
  });

  it('with no erase marker is revoked and forgotten, and the rows are untouched', async () => {
    const before = await dump();
    await settlePendingPairing();
    expect(pod.revoked.has(TOKEN)).toBe(true);
    expect(podState.get()).toBeNull();
    expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
    expect(await dump()).toBe(before);
  });

  it('with an erase marker from before the item (an earlier pairing) is treated as not erased', async () => {
    await setSetting(PAIRING_ERASED_KEY, '4999');
    await settlePendingPairing();
    expect(pod.revoked.has(TOKEN)).toBe(true);
    expect(podState.get()).toBeNull();
  });

  it('with an erase marker at or after the item becomes active, and nothing is revoked', async () => {
    await setSetting(PAIRING_ERASED_KEY, '5000');
    await settlePendingPairing();
    expect(pod.revoked.size).toBe(0);
    expect(podState.get()).toMatchObject({ state: 'active', token: TOKEN });
    expect(podPaired()).toBe(true);
  });

  it('a pending item without a time is not trusted to have been erased', async () => {
    await podState.save(pending({ pendingAt: undefined }));
    await setSetting(PAIRING_ERASED_KEY, '99999999999999');
    await settlePendingPairing();
    expect(podState.get()).toBeNull();
  });

  it('an active item is left alone', async () => {
    await podState.save(pending({ state: 'active' }));
    await settlePendingPairing();
    expect(podPaired()).toBe(true);
    expect(pod.requests).toEqual([]);
  });

  it('an item with no confirmation reads as not paired', async () => {
    await podState.save({ ...pending({ state: 'active' }), confirmed: null as never });
    podState.resetMemory();
    await podState.hydrate();
    expect(podState.get()).toBeNull();
    expect(podPaired()).toBe(false);
  });

  describe('through the start of the app', () => {
    const boot = async () => {
      podState.resetMemory();
      await platform('pod-pairing test').hydrateHostState!();
    };

    it('the app closed after the erase but before the item turned active: it starts paired, with nothing revoked', async () => {
      await setSetting(PAIRING_ERASED_KEY, '5000');
      await boot();
      expect(podPaired()).toBe(true);
      expect(platform('pod-pairing test').podCommand).toBeDefined();
      expect(pod.revoked.size).toBe(0);
    });

    it('the app closed before the erase: it starts unpaired, the server is told, and the rows are untouched', async () => {
      // The app's own start moves a display setting out of the database, so the rows are compared, not every setting.
      const rows = async () => {
        const all = JSON.parse(await dump()) as Record<string, unknown>;
        return JSON.stringify(['facts', 'conversations', 'messages', 'notifications', 'user_personas'].map((t) => all[t]));
      };
      const before = await rows();
      await boot();
      expect(podPaired()).toBe(false);
      expect(platform('pod-pairing test').podCommand).toBeUndefined();
      expect(pod.revoked.has(TOKEN)).toBe(true);
      expect(secureStoreDump()[POD_PAIRING_KEY]).toBeUndefined();
      expect(await rows()).toBe(before);
    });

    it('the app closed after the item turned active but before the restart: it starts paired, asking the server nothing', async () => {
      await podState.save(pending({ state: 'active' }));
      pod.requests.length = 0;
      await boot();
      expect(podPaired()).toBe(true);
      expect(platform('pod-pairing test').podCommand).toBeDefined();
      expect(pod.requests.filter((r) => r.path === '/devices/revoke' || r.path === '/pair')).toEqual([]);
    });
  });

  it('refuses to save an item with no confirmation', async () => {
    const err = await fail(import('@/lib/own-services/pod-state').then((m) => m.savePairing({ ...pending(), confirmed: undefined as never })));
    expect(err).toBeInstanceOf(OwnServiceError);
    expect(err.code).toBe('not-confirmed');
  });
});

describe('the settings the erase meets', () => {
  const SOURCE_ROOTS = ['lib', 'components', 'app', 'hooks'];
  const ROOT = path.resolve(__dirname, '../../../..');

  function sourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
      return /\.tsx?$/.test(e.name) ? [p] : [];
    });
  }

  /** Every key the app gives to setSetting: literal, or a constant it names. */
  function declaredKeys(): string[] {
    const constants = new Map<string, Set<string>>();
    const named = new Set<string>();
    const literal = new Set<string>();
    for (const file of SOURCE_ROOTS.flatMap((r) => sourceFiles(path.join(ROOT, r)))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]*)\s*(?::\s*string)?\s*=\s*'([a-z0-9_.:-]+)'/g)) {
        constants.set(m[1], (constants.get(m[1]) ?? new Set()).add(m[2]));
      }
      for (const m of text.matchAll(/\bsetSetting\(\s*([^,)]+)/g)) {
        const arg = m[1].trim();
        if (/^'[^']+'$/.test(arg)) literal.add(arg.slice(1, -1));
        else if (/^[A-Z][A-Z0-9_]*$/.test(arg)) named.add(arg);
      }
    }
    const keys = new Set(literal);
    for (const name of named) for (const key of constants.get(name) ?? []) keys.add(key);
    return [...keys].sort();
  }

  it('finds the keys the app declares', () => {
    const keys = declaredKeys();
    expect(keys.length).toBeGreaterThan(30);
    for (const known of ['pending_notification_hours', 'pod_sync_hashes', 'feed_privacy_intro_dismissed', 'developer_mode', 'cached_user_id']) {
      expect(keys).toContain(known);
    }
  });

  it('every key the app writes is kept, served, written by the erase, or erased on purpose', () => {
    const classified = new Set<string>([
      ...PAIRING_KEEP_SETTING_KEYS,
      ...APP_KEEP_SETTING_KEYS,
      ...ERASED_ON_PURPOSE,
      'onboarding_done',
      PAIRING_ERASED_KEY,
    ]);
    const unclassified = declaredKeys().filter((k) => !classified.has(k) && !isSyncSettingKey(k) && !k.startsWith('tutorial_'));
    // Pairing erases this phone and only the server's data counts: a new key is erased unless it is
    // named in a keep list for a reason, and it must be named in ERASED_ON_PURPOSE to say so.
    if (unclassified.length) {
      throw new Error(`Unclassified setting keys: ${unclassified.join(', ')}. Pairing erases them. Add each to ERASED_ON_PURPOSE in lib/own-services/erase-keep.ts, or to a keep list with its reason.`);
    }
  });

  it('no key is both kept and erased on purpose', () => {
    const kept = new Set([...PAIRING_KEEP_SETTING_KEYS, ...APP_KEEP_SETTING_KEYS]);
    expect(ERASED_ON_PURPOSE.filter((k) => kept.has(k) || isSyncSettingKey(k))).toEqual([]);
    expect(ERASED_ON_PURPOSE).toEqual(expect.arrayContaining(['pending_notification_hours', 'pod_sync_hashes']));
  });

  it('the app list holds the device keys the client list lacks', () => {
    expect([...APP_KEEP_SETTING_KEYS].sort()).toEqual(
      [
        'developer_mode', 'ota_last_running_update', 'ota_update_noticed_id', 'last_handled_notification_id', 'invoices_note_shown',
        'feed_privacy_intro_dismissed', 'last_foreground_at', 'mera_selected_model_id', 'mera_chat_in_cloud',
      ].sort(),
    );
  });

  it('keeps every tutorial key the phone has', async () => {
    await setSetting('tutorial_chapter_feed_completed', '1');
    await setSetting('tutorial_seen_x', 'y');
    const keys = await appKeepSettingKeys();
    expect(keys).toEqual(expect.arrayContaining(['tutorial_chapter_feed_completed', 'tutorial_seen_x', ...APP_KEEP_SETTING_KEYS]));
  });
});

describe('pairing links', () => {
  const link = (u: string, c?: string) => `meraapp://pod-pair?u=${encodeURIComponent(u)}${c === undefined ? '' : `&c=${c}`}`;

  it('reads the address and the code', () => {
    expect(parsePairLink(link('https://Pod.Own.Test/', CODE))).toEqual({ ok: true, baseUrl: 'https://pod.own.test', host: 'pod.own.test', code: CODE });
  });

  it.each([
    ['userinfo', link('https://me:pw@pod.own.test', CODE)],
    ['http', link('http://pod.own.test', CODE)],
    ['a Unicode host', link('https://pödø.own.test', CODE)],
    ['no code', link('https://pod.own.test')],
    ['an empty code', link('https://pod.own.test', '')],
    ['a code over 32 characters', link('https://pod.own.test', 'A'.repeat(33))],
    ['no address', `meraapp://pod-pair?c=${CODE}`],
    ['another path', `meraapp://elsewhere?u=${encodeURIComponent('https://pod.own.test')}&c=${CODE}`],
    ['not a link', 'hello'],
  ])('refuses %s', (_name, url) => {
    expect(parsePairLink(url)).toEqual({ ok: false });
  });

  it('accepts the xn-- form of a host and shows it as written', () => {
    expect(parsePairLink(link('https://xn--pd-hoa.own.test', CODE))).toMatchObject({ ok: true, host: 'xn--pd-hoa.own.test' });
  });

  it('a code of 32 characters passes', () => {
    expect(parsePairLink(link('https://pod.own.test', 'A'.repeat(32)))).toMatchObject({ ok: true });
  });

  it('takePendingPairLink answers once, and null after ten minutes', () => {
    useFakeClock('2026-01-01T00:00:00Z');
    const ok = parsePairLink(link('https://pod.own.test', CODE));
    if (!ok.ok) throw new Error('link should parse');
    setPendingPairLink(ok);
    expect(takePendingPairLink()).toEqual(ok);
    expect(takePendingPairLink()).toBeNull();

    setPendingPairLink(ok);
    jest.advanceTimersByTime(10 * 60_000 + 1);
    expect(takePendingPairLink()).toBeNull();

    setPendingPairLink(ok);
    jest.advanceTimersByTime(9 * 60_000);
    expect(takePendingPairLink()).toEqual(ok);
  });
});

describe('what never appears', () => {
  it('no token, code, address or snapshot content in a log line, a breadcrumb or an error', async () => {
    const errors: unknown[] = [];
    errors.push(await fail(pairAndErase({ baseUrl: POD_URL, code: 'NOPE0000' }, CONFIRMED)));
    pod.answer('/snapshot', 500);
    errors.push(await fail(pairAndErase(pairInput, CONFIRMED)));
    pod.snapshot.tables.facts = { ...pod.snapshot.tables.facts, rows: [{ id: 'dup', statement: SERVER_FACT }, { id: 'dup', statement: SERVER_FACT }] };
    errors.push(await fail(pairAndErase(pairInput, CONFIRMED)));
    // The first server's code is spent: a fresh server, the same phone data.
    pod = fakePod();
    await serveSnapshot();
    await seedPhone();
    await pairWithRestart();
    const token = (podState.get() as PodPairing).token;
    errors.push(await fail(pairAndErase({ baseUrl: 'http://pod.own.test', code: CODE }, CONFIRMED)));

    const seen = JSON.stringify([
      logs.flatMap((s) => s.mock.calls),
      (Sentry.addBreadcrumb as jest.Mock).mock.calls,
      (Sentry.captureException as jest.Mock).mock.calls,
      errors.map((e) => ({ ...(e as object), message: (e as Error).message, stack: (e as Error).stack })),
    ]);
    for (const secret of [token, CODE, 'pod.own.test', 'PLANTED-SNAPSHOT-MARKER', 'NOPE0000']) expect(seen).not.toContain(secret);
  });
});
