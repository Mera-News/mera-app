// ONE in-app message for every cloud-only action a reader triggers while the
// app is on-device (never a native alert, never a silent failure). Shared copy:
// `chat.cloudOnlyNotice`. Background jobs skip silently instead; see
// on-device-gate.ts. The i18n instance is required lazily (lib/i18n pulls the
// OS translator's native module at load).

import { showDialog } from '../dialog';
import { isOnDeviceMode } from './on-device-gate';

/** The shared body line, in the reader's language. */
export function cloudOnlyNoticeText(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18n = (require('../i18n') as typeof import('../i18n')).default;
  return i18n.t('chat.cloudOnlyNotice');
}

/** The dialog (one OK button). Resolves once it is dismissed. */
export async function showCloudOnlyNotice(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const i18n = (require('../i18n') as typeof import('../i18n')).default;
  await showDialog({
    title: i18n.t('meraProtocol.title'),
    body: cloudOnlyNoticeText(),
    confirmLabel: i18n.t('common.ok'),
  });
}

/** True (after showing the notice) when the action must not run on-device. */
export async function blockIfOnDevice(): Promise<boolean> {
  if (!(await isOnDeviceMode())) return false;
  void showCloudOnlyNotice();
  return true;
}
