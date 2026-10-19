// The wait line: the words under (cloud) or beside (device) the encryption
// strip. ONE sentence per phase, the first of the phase's pool. It does not
// rotate or fade: the strip carries the motion, and a line that holds still is
// read once instead of chased. Reduce Motion and Lite need no special case.
//
// It reads the phase store directly, so a phase tick re-renders this Text and
// not the thread. It is not an accessible element: the wait row is (see
// `WaitBubble`), and `usePhaseLine` hands that row the same words.

import { MAX_FONT_SCALE } from '@/lib/algorithms/policy';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import type { ChatPhaseId } from '@/lib/services/chat-phase';
import { useColors } from '@/lib/theme/tokens';
import { useTextScale } from '@/lib/typography/TextScaleContext';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { chatPhaseDef, CLOUD_WORD_LINES, OPENING_PHASE_ID } from './chat-phases';
import { usePhaseLineHeight } from './use-wait-row-height';

export interface ChatPhaseLineProps {
  testID?: string;
  /** Lines reserved: three under the cloud strip, two beside the phone. */
  lines?: number;
}

/**
 * The phase id and its line. THE THREE-STATE READ, and the two "no phase"
 * cases are opposites: `released` renders nothing (a fallback flashes the
 * opening sentence at the handover), `idle` renders the opening pool so a
 * caller that forgets to publish degrades to a sentence, not an empty bubble.
 */
export function usePhaseLine(): { phaseId: ChatPhaseId | null; line: string | null } {
  const { t } = useTranslation();
  const tAny = t as unknown as (key: string, opts?: object) => string | string[];
  const view = useChatPhaseStore((s) => s.view);
  const phaseId = view.kind === 'phase' ? view.id : view.kind === 'idle' ? OPENING_PHASE_ID : null;
  if (!phaseId) return { phaseId, line: null };
  const raw = tAny(chatPhaseDef(phaseId).phrasesKey, { returnObjects: true });
  const line = Array.isArray(raw) ? raw[0] : raw;
  return { phaseId, line: typeof line === 'string' && line.length > 0 ? line : null };
}

export const ChatPhaseLine: React.FC<ChatPhaseLineProps> = ({
  testID = 'chat-phase-line',
  lines = CLOUD_WORD_LINES,
}) => {
  const colors = useColors();
  const { line } = usePhaseLine();
  const lineHeight = usePhaseLineHeight();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, MAX_FONT_SCALE.content) * useTextScale();
  if (line === null) return null;
  return (
    <Text
      size="sm"
      accessible={false}
      style={{ color: colors.ink2, fontSize: 15, lineHeight, minHeight: lines * lineHeight * scale }}
      numberOfLines={lines}
      testID={testID}
    >
      {line}
    </Text>
  );
};

export default ChatPhaseLine;
