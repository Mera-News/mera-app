// The "?" explainer for a tab: what the tab is and how it decides what to
// show, in plain words (N4). One sheet for every tab that has one; each tab's
// header places `TabExplainerButton`, which owns the open state and mounts
// this sheet.
//
// ## The copy is a set of CLAIMS, so it has to stay true
//
// Every sentence here describes code: the Feed's tier and staleness order
// (`lib/feed-ordering/priority-order.ts`, `feed/feed-entries.ts`), the
// Dashboard's one-owner-per-story rule and its tie-break
// (`news-harness/feed-select/ownership.ts`) and 10-minute resort
// (`feed-ordering/dashboard-resort.ts`), Explore's server-side ranking, and
// the search-text privacy rule on the server. Change that code and the copy
// here is the first thing that goes false. The Explore and privacy lines were
// verified against the server before they shipped.
//
// ## Why a modal and not a pageSheet
//
// The app's Modal primitive already carries the dark over-content surface
// (GLASS_OVER_CONTENT_FILL); a native pageSheet's container is iOS's and takes
// none of it (see GlassSurface).

import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import React from 'react';
import { useTranslation } from 'react-i18next';

/** Settings has no ranking to explain, so it has no sheet. */
export type ExplainedTab = 'feed' | 'forYou' | 'explore' | 'profile';

/** The paragraph keys per tab, in reading order. Literal keys so `t()` stays
 *  typed. */
export const TAB_EXPLAINER_PARAGRAPHS = {
  feed: [
    'tabExplainer.feed.what',
    'tabExplainer.feed.how1',
    'tabExplainer.feed.how2',
    'tabExplainer.feed.how3',
    'tabExplainer.feed.privacy',
  ],
  forYou: [
    'tabExplainer.forYou.what',
    'tabExplainer.forYou.how1',
    'tabExplainer.forYou.how2',
    'tabExplainer.forYou.how3',
  ],
  explore: [
    'tabExplainer.explore.what',
    'tabExplainer.explore.how1',
    'tabExplainer.explore.how2',
  ],
  profile: [
    'tabExplainer.profile.what',
    'tabExplainer.profile.how1',
    'tabExplainer.profile.privacy',
  ],
} as const satisfies Record<ExplainedTab, readonly string[]>;

export const TAB_EXPLAINER_TITLES = {
  feed: 'tabExplainer.feed.title',
  forYou: 'tabExplainer.forYou.title',
  explore: 'tabExplainer.explore.title',
  profile: 'tabExplainer.profile.title',
} as const satisfies Record<ExplainedTab, string>;

export interface TabExplainerSheetProps {
  readonly tab: ExplainedTab;
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

const TabExplainerSheet: React.FC<TabExplainerSheetProps> = ({ tab, isOpen, onClose }) => {
  const { t } = useTranslation();
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent testID={`tab-explainer-${tab}`}>
        <ModalHeader>
          <Heading size="lg" className="text-white" accessibilityRole="header">
            {t(TAB_EXPLAINER_TITLES[tab])}
          </Heading>
        </ModalHeader>
        {/* Text only, so ModalBody's ScrollView holds no list. */}
        <ModalBody>
          <VStack space="md">
            {TAB_EXPLAINER_PARAGRAPHS[tab].map((key) => (
              <Text key={key} size="sm" style={{ color: 'rgb(212, 212, 212)' }}>
                {t(key)}
              </Text>
            ))}
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="outline"
            className="flex-1 border-white/30"
            onPress={onClose}
            testID={`tab-explainer-${tab}-close`}
          >
            <ButtonText className="text-white">{t('tabExplainer.close')}</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

export default TabExplainerSheet;
