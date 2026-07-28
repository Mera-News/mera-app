// use-track-button — the track button's PRESS behaviour + its "already
// following" dialog, in one place.
//
// Friction this removes (the repo rule: name it or don't add the pattern):
// three surfaces render a track button — ArticleFeedbackPrompt,
// ArticleActionsRow, CompactActionsSheet. Each now needs identical dialog state,
// identical copy, and identical navigation into the story timeline. Without this
// the modal boilerplate is triplicated, which is the same argument that
// justified `useTrackedSubject` itself.
//
// It also keeps UI out of lib/: `useTrackedSubject` (lib/tracking) stays
// RN-modal-free and only reports state + intent; the Gluestack dialog lives
// here, in components/.
//
// Behaviour (Q13):
//   untracked → the unchanged proposal flow (floating chat + auto-sent seed).
//   tracked   → a dialog explaining that re-following isn't possible and that
//               untracking deletes everything for the story, offering
//               [Go to story] [Cancel]. It deliberately does NOT offer untrack:
//               the destructive path lives on the story timeline, behind its own
//               confirm.

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
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useTrackedSubject } from '@/lib/tracking/use-tracked-subject';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface UseTrackButton {
  /** Whether an active story already covers this subject (drives the button's
   *  selected/filled state and its label). */
  tracked: boolean;
  /** Single press handler — routes to the proposal flow or the dialog. */
  onPress: () => void;
  /** Render this next to the button; null-safe to place unconditionally. */
  dialog: React.ReactNode;
}

/**
 * @param subject What is being followed + where.
 * @param active  Gate the underlying subscription (e.g. only when a sheet is
 *                open). Defaults to true.
 */
export function useTrackButton(
  subject: FeedbackSubject,
  active: boolean = true,
): UseTrackButton {
  const { t } = useTranslation();
  const { tracked, trackedStoryId, startTracking } = useTrackedSubject(subject, active);
  const [dialogOpen, setDialogOpen] = useState(false);

  const onPress = useCallback(() => {
    if (tracked) {
      setDialogOpen(true);
      return;
    }
    startTracking();
  }, [tracked, startTracking]);

  const close = useCallback(() => setDialogOpen(false), []);

  const goToStory = useCallback(() => {
    setDialogOpen(false);
    if (!trackedStoryId) return;
    router.push({
      pathname: '/logged-in/story-timeline',
      params: { trackedStoryId },
    });
  }, [trackedStoryId]);

  const dialog = (
    <Modal isOpen={dialogOpen} onClose={close}>
      <ModalBackdrop />
      <ModalContent>
        <ModalHeader>
          <Heading size="md" className="text-white" testID="already-tracking-title">
            {t('trackedStories.alreadyTrackingTitle')}
          </Heading>
        </ModalHeader>
        <ModalBody>
          <Text size="sm" className="text-typography-300">
            {t('trackedStories.alreadyTrackingBody')}
          </Text>
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" action="secondary" onPress={close} className="mr-3">
            <ButtonText>{t('common.cancel')}</ButtonText>
          </Button>
          <Button onPress={goToStory} testID="already-tracking-go">
            <ButtonText>{t('trackedStories.goToStoryAction')}</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );

  return { tracked, onPress, dialog };
}
