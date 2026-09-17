// The waiting word inside the assistant bubble. Replaces the three dots.
//
// A word that changes says a person is being worked for; three dots say a
// process is running. The pool rotates so a long wait does not read as a
// frozen screen, which is the job the dots used to do badly.

import { Text } from '@/components/ui/text';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  STREAMING_WORD_INTERVAL_MS,
  STREAMING_WORD_KEYS,
  shuffledCycle,
} from './streaming-words';

export interface StreamingWordProps {
  /** Overrides the pool entirely. Reasoning waits use the same bubble. */
  fixedLabel?: string;
  testID?: string;
}

export const StreamingWord: React.FC<StreamingWordProps> = ({
  fixedLabel,
  testID = 'streaming-word',
}) => {
  const { t } = useTranslation();
  const animationsActive = useAnimationsActive();

  // Literal keys so tsc checks each against the generated union: a pool word
  // that never reached the dictionaries is a build error, not a dot-path.
  const POOL = [
    t('streamingWords.w1'),
    t('streamingWords.w2'),
    t('streamingWords.w3'),
    t('streamingWords.w4'),
    t('streamingWords.w5'),
    t('streamingWords.w6'),
    t('streamingWords.w7'),
    t('streamingWords.w8'),
    t('streamingWords.w9'),
    t('streamingWords.w10'),
    t('streamingWords.w11'),
    t('streamingWords.w12'),
    t('streamingWords.w13'),
    t('streamingWords.w14'),
    t('streamingWords.w15'),
  ];

  const [index, setIndex] = useState(0);
  const cycle = useRef<number[]>([]);
  const cursor = useRef(0);

  // Reduced motion gets the opener and nothing else: a word changing on its
  // own is motion, whatever the mechanism, and someone who asked for less of
  // it did not mean "except in text".
  const rotates = animationsActive && !fixedLabel;

  useEffect(() => {
    if (!rotates) return;
    const timer = setInterval(() => {
      setIndex((prev) => {
        if (cursor.current >= cycle.current.length) {
          cycle.current = shuffledCycle(STREAMING_WORD_KEYS.length, prev);
          cursor.current = 0;
        }
        let next = cycle.current[cursor.current++];
        if (next === prev) {
          // The seam case shuffledCycle cannot see: skip one rather than
          // showing the same word twice.
          if (cursor.current >= cycle.current.length) {
            cycle.current = shuffledCycle(STREAMING_WORD_KEYS.length, prev);
            cursor.current = 0;
          }
          next = cycle.current[cursor.current++];
        }
        return next;
      });
    }, STREAMING_WORD_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [rotates]);

  const word = fixedLabel ?? POOL[index] ?? POOL[0];

  return (
    <Text
      size="sm"
      style={styles.word}
      // ONE polite live region carrying the current word. The avatar beside it
      // is decorative, so the wait is announced once, not twice.
      accessibilityLiveRegion="polite"
      accessibilityRole="text"
      accessibilityLabel={`${word}…`}
      testID={testID}
    >
      {`${word}…`}
    </Text>
  );
};

const styles = StyleSheet.create({
  word: { color: 'rgb(190, 190, 190)', fontSize: 15, lineHeight: 21 },
});

export default StreamingWord;
