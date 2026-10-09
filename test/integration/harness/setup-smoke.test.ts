import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import {
  advanceUntilSettled,
  failSecureStore,
  http,
  HttpResponse,
  secureStoreDump,
  server,
  setAppState,
  useFakeClock,
} from '@/test/helpers';
import { unhandled } from '@/test/helpers/msw';

describe('integration setup', () => {
  describe('storage', () => {
    it('round-trips expo-secure-store and injects per-key failures', async () => {
      await SecureStore.setItemAsync('k', 'v');
      await SecureStore.setItemAsync('other', 'o');
      expect(await SecureStore.getItemAsync('k')).toBe('v');
      expect(secureStoreDump()).toEqual({ k: 'v', other: 'o' });

      failSecureStore('k', 'get');
      await expect(SecureStore.getItemAsync('k')).rejects.toThrow('keychain failure (injected)');
      expect(await SecureStore.getItemAsync('other')).toBe('o');
    });

    it('starts each test with empty storage', async () => {
      expect(await SecureStore.getItemAsync('k')).toBeNull();
      expect(await AsyncStorage.getAllKeys()).toEqual([]);
    });

    it('round-trips AsyncStorage', async () => {
      await AsyncStorage.setItem('a', '1');
      expect(await AsyncStorage.getItem('a')).toBe('1');
      await AsyncStorage.removeItem('a');
      expect(await AsyncStorage.getItem('a')).toBeNull();
    });
  });

  it('hashes with real SHA-256', async () => {
    expect(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, 'abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('drives AppState listeners', () => {
    const seen: string[] = [];
    const sub = AppState.addEventListener('change', (s) => seen.push(s));
    setAppState('background');
    expect(seen).toEqual(['background']);
    expect(AppState.currentState).toBe('background');
    sub.remove();
    setAppState('active');
    expect(seen).toEqual(['background']);
  });

  it('fakes the clock and settles timers', async () => {
    useFakeClock('2026-10-09T00:00:00Z');
    expect(Date.now()).toBe(Date.parse('2026-10-09T00:00:00Z'));
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 5000);
    await advanceUntilSettled();
    expect(fired).toBe(true);
  });

  it('imports reanimated and safe-area-context', () => {
    expect(() => require('react-native-reanimated')).not.toThrow();
    expect(() => require('react-native-safe-area-context')).not.toThrow();
  });

  describe('MSW', () => {
    it('serves a per-test override', async () => {
      server.use(http.get('*/x', () => HttpResponse.text('ok')));
      const res = await fetch('http://127.0.0.1:8790/x');
      expect(await res.text()).toBe('ok');
    });

    it('records an unhandled request and rejects the fetch', async () => {
      await expect(fetch('http://127.0.0.1:8790/x')).rejects.toThrow();
      // Control: the setup's afterEach would fail this test on a non-empty list.
      expect(unhandled).toEqual(['GET http://127.0.0.1:8790/x']);
      unhandled.splice(0);
    });
  });
});
