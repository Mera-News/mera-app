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
 *  same as `tabs_tooltip_seen`).
 *
 *  A NEW key, deliberately not the previous `whats_new_v3_seen`. That one is
 *  already set for everyone who saw the v3 sheet, so reusing it would show this
 *  announcement to nobody. The old key is left in the settings table untouched:
 *  it is one row, and clearing it would re-arm the v3 sheet for anyone still on
 *  a build that reads it. */
const WHATS_NEW_SEEN_KEY = 'whats_new_starter_seen';

type RowKey = 'articles' | 'interests' | 'chat' | 'stories';

const ROWS: { key: RowKey; icon: keyof typeof MaterialIcons.glyphMap; titleKey: string; bodyKey: string }[] = [
  { key: 'articles', icon: 'dynamic-feed', titleKey: 'whatsNew.starterArticlesTitle', bodyKey: 'whatsNew.starterArticlesBody' },
  { key: 'interests', icon: 'auto-awesome', titleKey: 'whatsNew.starterInterestsTitle', bodyKey: 'whatsNew.starterInterestsBody' },
  { key: 'chat', icon: 'person', titleKey: 'whatsNew.starterChatTitle', bodyKey: 'whatsNew.starterChatBody' },
  { key: 'stories', icon: 'sync', titleKey: 'whatsNew.starterStoriesTitle', bodyKey: 'whatsNew.starterStoriesBody' },
];

/**
 * One-time "What's new" sheet shown on the first launch after this OTA. It now
 * announces that every account includes the full Starter plan at no cost.
 *
 * Gated by the `whats_new_starter_seen` settings flag AND an existing-user
 * heuristic.
 *
 * EXISTING USERS ONLY, and this is a product decision rather than inherited v3
 * behaviour. The announcement is a before-and-after: it only means something to
 * someone who already used Mera under the old limits. A brand-new user has no
 * "before" to contrast against, and meeting a modal before meeting the product
 * is worse than meeting the product. So a fresh install is never shown it, and
 * the flag is set anyway so it can never surface later once that user has a
 * feed.
 *
 * Existing-user signal: persisted `feed_metadata` (written only after a prior
 * feed processing run). A fresh install has none at first For You render. This
 * is a stronger signal than `cached_user_id`, which is set at login and so
 * cannot distinguish a fresh install by the time this mounts.
 */
const WhatsNewSheet: React.FC = () => {
  const { t } = useTranslation();
  // TEMPORARY hatch for the two Starter keys used as literals here. `t()` is
  // typed off en.json (lib/i18n/types.ts) with no codegen step, so a key that
  // has not been spliced yet fails tsc. Convert both to typed `t()` once the
  // starter-free splice lands. The per-row keys below already go through a cast
  // because they are computed.
  const tAny = t as (key: string) => string;
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
          // Fresh install. Never show it: there is no "before" for this
          // announcement to contrast with, and a modal ahead of the product is
          // a worse first run than the product. Set the flag anyway so it
          // cannot appear later, once this user does have a feed.
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
          <Heading size="xl" className="text-white">
            {tAny('whatsNew.starterTitle')}
          </Heading>
        </ModalHeader>
        <ModalBody>
          <VStack space="lg" className="py-1">
            <Text size="sm" className="text-typography-400">
              {tAny('whatsNew.starterIntro')}
            </Text>
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
