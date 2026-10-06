// Per-tab fractional page index (0 = first page, 1.5 = halfway between the
// second and third), written on the UI thread by TabPages while a page swipe
// moves and read by the Mera button, which fades with the Profile/Settings
// swipe on You. A module-level shared value per tab: the reader mounts beside
// the tab's Stack, outside the pager's tree. Reanimated is required lazily so
// the RN-free modules that import nav/ never load its native module in jest.

import type { SharedValue } from 'react-native-reanimated';

import type { TabId } from './page-registry';

const progress = new Map<TabId, SharedValue<number>>();

export function tabSwipeProgress(tab: TabId): SharedValue<number> {
  let value = progress.get(tab);
  if (!value) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { makeMutable } = require('react-native-reanimated') as typeof import('react-native-reanimated');
    value = makeMutable(0);
    progress.set(tab, value);
  }
  return value;
}
