// The wait row: the encryption strip and, optionally, the phase words. A
// borderless row that holds a fixed height (`useWaitRowHeight`) so the reply
// takes its slot without moving the thread.
//
// The row View is the SINGLE accessible element and carries the phase line as
// its label. There is no live region anywhere: `useAnnounce` speaks a status
// only once it has held, a retry at once.

import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { DEVICE_WORD_LINES } from './chat-phases';
import ChatPhaseLine, { usePhaseLine } from './ChatPhaseLine';
import EncryptionStrip from './EncryptionStrip';
import { useAnnounce } from './phase-announcer';
import { stripRests } from './strip-display';
import { useWaitRowHeight } from './use-wait-row-height';

export interface WaitBubbleProps {
  testID?: string;
  /** The phase words under or beside the strip. Default on. */
  showWords?: boolean;
  /** The loop's acknowledgement is on screen above this row. */
  ackShowing?: boolean;
  engine?: 'cloud' | 'local';
}

export const WaitBubble: React.FC<WaitBubbleProps> = ({
  testID = 'chat-wait-bubble',
  showWords = true,
  ackShowing = false,
  engine: engineProp,
}) => {
  const onDevice = useIsOnDeviceProcessing();
  const engine = engineProp ?? (onDevice ? 'local' : 'cloud');
  const local = engine === 'local';
  const minHeight = useWaitRowHeight(showWords, engine);
  const sealedSeq = useChatPhaseStore((s) => s.sealedSeq);
  const liveTool = useChatPhaseStore((s) => s.liveTool !== null);
  const { phaseId, line } = usePhaseLine();
  useAnnounce(line, phaseId === 'retrying');

  // The acknowledgement's rising edge asks the strip for one `return`; the ack
  // "streams" until a new seal happens after that edge.
  const [playReturn, setPlayReturn] = useState(0);
  const [ackSeq, setAckSeq] = useState<number | null>(ackShowing ? sealedSeq : null);
  const wasShowing = useRef(false);
  useEffect(() => {
    if (ackShowing && !wasShowing.current) {
      setPlayReturn((n) => n + 1);
      setAckSeq(sealedSeq);
    } else if (!ackShowing) {
      setAckSeq(null);
    }
    wasShowing.current = ackShowing;
  }, [ackShowing, sealedSeq]);
  const ackStreaming = ackShowing && ackSeq !== null && sealedSeq === ackSeq;
  // ponytail: `landing` (step rows landing) is the steps box's signal, not wired here yet.
  const rest = stripRests({ liveTool, landing: false, ackStreaming });

  const strip = <EncryptionStrip host="row" rest={rest} playReturn={playReturn} />;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={line ?? undefined}
      testID={testID}
      style={[styles.row, { minHeight }, local && styles.localRow]}
    >
      {local ? (
        <>
          {strip}
          {showWords && (
            <View style={styles.words}>
              <ChatPhaseLine lines={DEVICE_WORD_LINES} />
            </View>
          )}
        </>
      ) : (
        <>
          {strip}
          {showWords && (
            <View style={styles.cloudWords}>
              <ChatPhaseLine />
            </View>
          )}
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  row: { paddingVertical: 8, paddingHorizontal: 14, justifyContent: 'center' },
  localRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  words: { flex: 1, justifyContent: 'center' },
  cloudWords: { marginTop: 6 },
});

export default WaitBubble;
