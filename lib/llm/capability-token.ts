// Per-cycle capability token cache. Lives in AsyncStorage so background-task
// callers (silent-push wakes) can authenticate against the inference gateway
// without ever reading the keychain. Minted by the gateway on the initial
// POST /jobs response and by the phase-2 follow-up submit; cleared when the
// cycle returns to `idle`.

import AsyncStorage from '@react-native-async-storage/async-storage';
import logger from '@/lib/logger';

const KEY = 'mera.cycle.capabilityToken';

export async function setCapabilityToken(token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, token);
  } catch (err) {
    logger.warn(`[capability-token] setCapabilityToken failed: ${String(err)}`);
  }
}

export async function getCapabilityToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY);
  } catch (err) {
    logger.warn(`[capability-token] getCapabilityToken failed: ${String(err)}`);
    return null;
  }
}

export async function clearCapabilityToken(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch (err) {
    logger.warn(`[capability-token] clearCapabilityToken failed: ${String(err)}`);
  }
}
