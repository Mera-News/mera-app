// The tab shell: page strip header, one collapsing header shared by the
// tab's pages, the windowed swipe pager and the swipe into the next tab.
//
// CONTRACT STUB (navx P3 lands the real component): renders the first page,
// active, under the shared collapsing-header binding, so content lanes can
// mount and type-check their page sets against the final props.

import React from 'react';
import { View } from 'react-native';

import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';

import type { TabPagesProps } from './types';

export type { TabPagesProps } from './types';

const TabPages: React.FC<TabPagesProps> = ({ pages, renderPage, testID }) => {
  const { scrollHandler, headerHeight, hidden, reveal } = useCollapsibleHeader();
  const first = pages[0];
  return (
    <View style={{ flex: 1 }} testID={testID}>
      {first
        ? renderPage({
            pageId: first.id,
            active: true,
            header: { scrollHandler, headerHeight, hidden, reveal },
            params: null,
          })
        : null}
    </View>
  );
};

export default TabPages;
