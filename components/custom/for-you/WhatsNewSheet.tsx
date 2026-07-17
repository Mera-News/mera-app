import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Heading } from '@/components/ui/heading';
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@/components/ui/modal';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { loadFeedMetadata } from '@/lib/database/services/article-suggestion-service';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/** Settings KV flag gating the one-time sheet (existing setting-service pattern,
 *  same as `tabs_tooltip_seen`). */
const WHATS_NEW_SEEN_KEY = 'whats_new_v3_seen';

type RowKey = 'sections' | 'stories' | 'tabs' | 'resync';

const ROWS: { key: RowKey; icon: keyof typeof MaterialIcons.glyphMap; titleKey: string; bodyKey: string }[] = [
  { key: 'sections', icon: 'dynamic-feed', titleKey: 'whatsNew.sectionsTitle', bodyKey: 'whatsNew.sectionsBody' },
  { key: 'stories', icon: 'auto-awesome', titleKey: 'whatsNew.storiesTitle', bodyKey: 'whatsNew.storiesBody' },
  { key: 'tabs', icon: 'person', titleKey: 'whatsNew.tabsTitle', bodyKey: 'whatsNew.tabsBody' },
  { key: 'resync', icon: 'sync', titleKey: 'whatsNew.resyncTitle', bodyKey: 'whatsNew.resyncBody' },
];

/**
 * One-time "What's new" sheet shown on the first launch after this OTA (Wave 7c
 * N2). Gated by the `whats_new_v3_seen` settings flag AND an existing-user
 * heuristic: only users who already had a feed before this update should see it
 * — a brand-new install (mid-onboarding) is not shown it, but the flag is still
 * set so it can never appear later.
 *
 * Existing-user signal: persisted `feed_metadata` (written only after a prior
 * feed processing run). A fresh install has none at first For You render. This
 * is a stronger signal than the plan's literal `cached_user_id` note, which is
 * set at login and so can't distinguish a fresh install by the time For You
 * mounts.
 */
const WhatsNewSheet: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const seen = await getSetting(WHATS_NEW_SEEN_KEY);
        if (seen) return; // already shown / set once
        const meta = await loadFeedMetadata();
        const isExistingUser = meta != null;
        if (cancelled) return;
        if (isExistingUser) {
          setOpen(true); // flag is set on dismiss
        } else {
          // Fresh install — never show; set the flag so it stays dismissed.
          await setSetting(WHATS_NEW_SEEN_KEY, '1');
        }
      } catch (err) {
        logger.captureException(err, {
          tags: { component: 'WhatsNewSheet', method: 'gate' },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setOpen(false);
    setSetting(WHATS_NEW_SEEN_KEY, '1').catch((err: unknown) => {
      logger.captureException(err, {
        tags: { component: 'WhatsNewSheet', method: 'dismiss' },
      });
    });
  };

  if (!open) return null;

  return (
    <Modal isOpen={open} onClose={dismiss} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-gray-950 border border-gray-800">
        <ModalHeader>
          <Heading size="lg" className="text-white">
            {t('whatsNew.title')}
          </Heading>
        </ModalHeader>
        <ModalBody>
          <VStack space="lg" className="py-1">
            {ROWS.map((row) => (
              <HStack key={row.key} className="items-start" space="md">
                <Box
                  className="rounded-full p-2"
                  style={{ backgroundColor: 'rgba(231,138,83,0.15)' }}
                >
                  <MaterialIcons name={row.icon} size={20} color={ACCENT} />
                </Box>
                <VStack className="flex-1 min-w-0">
                  <Text size="sm" bold className="text-white">
                    {t(row.titleKey as any)}
                  </Text>
                  <Text size="xs" className="text-typography-400">
                    {t(row.bodyKey as any)}
                  </Text>
                </VStack>
              </HStack>
            ))}
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button className="flex-1 bg-primary-400" onPress={dismiss}>
            <ButtonText>{t('whatsNew.gotIt')}</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

export default WhatsNewSheet;
