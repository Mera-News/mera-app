// Whether deleting a fact's topic asks first. Per device (AsyncStorage, so an
// account switch keeps it): the confirm dialog's "Don't ask again" turns it
// off, Settings › Your data's switch turns it back on. Stored inverted, as the
// "skip" flag, so a device with nothing stored asks.

import AsyncStorage from '@react-native-async-storage/async-storage';

export const SKIP_TOPIC_DELETE_CONFIRM_KEY = 'fact_topic_delete_skip_confirm';

export async function shouldConfirmTopicDelete(): Promise<boolean> {
    try {
        return (await AsyncStorage.getItem(SKIP_TOPIC_DELETE_CONFIRM_KEY)) !== '1';
    } catch {
        return true;
    }
}

export async function setConfirmTopicDelete(ask: boolean): Promise<void> {
    try {
        if (ask) await AsyncStorage.removeItem(SKIP_TOPIC_DELETE_CONFIRM_KEY);
        else await AsyncStorage.setItem(SKIP_TOPIC_DELETE_CONFIRM_KEY, '1');
    } catch {
        // A failed write leaves the previous choice; nothing to undo.
    }
}
