import Constants from 'expo-constants';

export const APP_SLUG = Constants.expoConfig?.slug || 'app';

// A mode is on exactly while its key exists, so a backup restore can never turn one on.
export const OWN_AI_KEY = `${APP_SLUG}_own_ai`;
export const OWN_NEWS_KEY = `${APP_SLUG}_own_news`;
export const POD_PAIRING_KEY = `${APP_SLUG}_pod_pairing`;
