// TrackProposalSheet — the AI "what should I track?" sheet.
//
// Mounted once at the logged-in root. When the shared `useTrackedSubject` hook's
// track path calls `useTrackProposalStore.open(subject)`, this opens immediately
// in a "thinking" state, runs one track-proposal LLM round (cloud with on-device
// fallback via `runTrackProposal`), and shows the proposed topic. The user can
// accept it (Track), refine it with a free-text instruction (re-runs the round
// with the previous proposal + their instruction as context), or cancel. On
// accept it mints the topic + the local TrackedStory via `trackStoryWithProposal`
// and fires the initiating hook's `onTracked` so its button reflects the follow.
//
// Follows the CompactActionsSheet modal idiom (transparent Modal, dimmed
// backdrop, dark rounded bottom sheet) without importing it.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import MeraLogo from '@/components/custom/MeraLogo';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { runTrackProposal } from '@/lib/inference/handlers/track-proposal-handler';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useTrackProposalStore } from '@/lib/stores/track-proposal-store';
import { trackStoryWithProposal } from '@/lib/tracking/track-actions';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from 'react-native';

const ACCENT = '#EDA77E';

type Phase = 'thinking' | 'ready' | 'error';

export const TrackProposalSheet: React.FC = () => {
  const { t } = useTranslation();
  const { visible, subject, onTracked, close } = useTrackProposalStore();

  const [phase, setPhase] = useState<Phase>('thinking');
  const [proposal, setProposal] = useState('');
  const [instruction, setInstruction] = useState('');
  const [tracking, setTracking] = useState(false);
  // Guards a stale async round from writing after the sheet reopened/closed.
  const runIdRef = useRef(0);

  const useCloud =
    useMeraProtocolStore.getState().processingMode === ProcessingMode.Cloud;

  /** Run one proposal round. `previousProposal`/`userInstruction` set ⇒ revision. */
  const runRound = useCallback(
    async (previousProposal?: string, userInstruction?: string) => {
      if (!subject) return;
      const runId = ++runIdRef.current;
      setPhase('thinking');
      try {
        const text = await runTrackProposal(
          {
            title: subject.title,
            previousProposal: previousProposal ?? null,
            userInstruction: userInstruction ?? null,
          },
          useCloud,
        );
        if (runId !== runIdRef.current) return; // superseded
        setProposal(text);
        setPhase('ready');
      } catch (err) {
        if (runId !== runIdRef.current) return;
        logger.warn('[TrackProposalSheet] proposal round failed', {
          error: String(err),
        });
        setPhase('error');
      }
    },
    [subject, useCloud],
  );

  // Kick off the first round each time the sheet opens for a subject.
  useEffect(() => {
    if (!visible || !subject) return;
    setProposal('');
    setInstruction('');
    setTracking(false);
    void runRound();
    // Re-run only on a genuine (re)open for a new article.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, subject?.articleId]);

  const handleClose = useCallback(() => {
    runIdRef.current++; // invalidate any in-flight round
    close();
  }, [close]);

  const handleTweak = useCallback(() => {
    const instr = instruction.trim();
    if (!instr) return;
    hapticLight();
    setInstruction('');
    void runRound(proposal, instr);
  }, [instruction, proposal, runRound]);

  const handleTrack = useCallback(async () => {
    if (!subject || !proposal.trim() || tracking) return;
    setTracking(true);
    hapticSuccess();
    try {
      await trackStoryWithProposal(subject, proposal);
      onTracked?.();
    } catch (err) {
      logger.warn('[TrackProposalSheet] track failed', { error: String(err) });
    } finally {
      handleClose();
    }
  }, [subject, proposal, tracking, onTracked, handleClose]);

  if (!visible || !subject) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <Pressable
        accessibilityLabel={t('common.cancel')}
        onPress={handleClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.72)',
          justifyContent: 'flex-end',
        }}
      >
        <Pressable onPress={() => {}} style={{ width: '100%' }}>
          <Box
            className="rounded-t-3xl px-5 pb-8 pt-4"
            style={{
              backgroundColor: '#151515',
              borderTopColor: '#2a2a2a',
              borderTopWidth: 1,
            }}
          >
            <VStack space="md">
              <HStack className="items-center" space="sm">
                <MeraLogo size={22} />
                <Text
                  className="text-typography-0"
                  style={{ fontSize: 16, fontWeight: '700' }}
                >
                  {t('trackedStories.trackAction')}
                </Text>
              </HStack>

              {phase === 'thinking' ? (
                <HStack className="items-center py-6" space="md">
                  <Spinner size="small" />
                  <Text size="sm" className="text-typography-300 flex-1">
                    {t('trackedStories.proposeThinking')}
                  </Text>
                </HStack>
              ) : phase === 'error' ? (
                <VStack space="md" className="py-2">
                  <Text size="sm" className="text-typography-300">
                    {t('trackedStories.proposeError')}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('trackedStories.proposeRetry')}
                    onPress={() => void runRound()}
                    className="self-start rounded-xl px-4 py-2"
                    style={{ backgroundColor: '#2a2a2a' }}
                  >
                    <Text style={{ color: ACCENT, fontWeight: '600' }}>
                      {t('trackedStories.proposeRetry')}
                    </Text>
                  </Pressable>
                </VStack>
              ) : (
                <VStack space="sm">
                  <Text
                    size="xs"
                    className="text-typography-400"
                    style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}
                  >
                    {t('trackedStories.proposeLabel')}
                  </Text>
                  <Box
                    className="rounded-2xl px-4 py-3"
                    style={{ backgroundColor: '#1e1e1e' }}
                  >
                    <TranslatableDynamic
                      text={proposal}
                      as="text"
                      size="md"
                      className="text-white"
                    />
                  </Box>

                  <Input
                    variant="outline"
                    size="md"
                    className="mt-1"
                    style={{ borderColor: '#2a2a2a' }}
                  >
                    <InputField
                      value={instruction}
                      onChangeText={setInstruction}
                      onSubmitEditing={handleTweak}
                      returnKeyType="send"
                      placeholder={t('trackedStories.proposeTweakPlaceholder')}
                      placeholderTextColor="#6B7280"
                      className="text-white"
                    />
                  </Input>

                  <HStack space="sm" className="mt-2 items-center justify-end">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('trackedStories.proposeCancel')}
                      onPress={handleClose}
                      className="rounded-xl px-4 py-3"
                    >
                      <Text className="text-typography-300" style={{ fontWeight: '600' }}>
                        {t('trackedStories.proposeCancel')}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('trackedStories.proposeTrack')}
                      onPress={() => void handleTrack()}
                      disabled={tracking}
                      className="rounded-xl px-5 py-3"
                      style={{ backgroundColor: ACCENT, opacity: tracking ? 0.6 : 1 }}
                    >
                      <HStack className="items-center" space="xs">
                        <MaterialIcons name="track-changes" size={18} color="#151515" />
                        <Text style={{ color: '#151515', fontWeight: '700' }}>
                          {t('trackedStories.proposeTrack')}
                        </Text>
                      </HStack>
                    </Pressable>
                  </HStack>
                </VStack>
              )}
            </VStack>
          </Box>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

export default TrackProposalSheet;
