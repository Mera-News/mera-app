// A page's explainer: the sheet the ? beside a page title opens. Title, the
// page's paragraphs, then Learn more (outlined, opens the tutorial chapter)
// and Got it (filled orange). Got it, a scrim tap or a drag down closes it.
//
// The surface, scrim, rise and drag-to-dismiss are BottomSheet's; this file is
// only the content. A sheet opened from inside a tab survives a tab switch,
// so its host (TabPages) closes it on blur. Learn more closes the sheet and
// pushes the tutorial only once it is fully gone (`onClosed`): an RN Modal
// paints above a root push.
//
// Learn more shows only while its chapter exists (some pages get theirs later).

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { getChapter } from '@/lib/tutorials/chapters';
import { router, type Href } from 'expo-router';
import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { COLORS, useColors } from '@/lib/theme/tokens';
import type { PageExplainer } from './page-registry';

export interface PageExplainerSheetProps {
  readonly explainer: PageExplainer | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

const PageExplainerSheet: React.FC<PageExplainerSheetProps> = ({ explainer, open, onClose }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const tutorialHref = useRef<Href | null>(null);
  // Keep the last copy while the sheet slides away after its host clears it.
  const last = useRef(explainer);
  if (explainer) last.current = explainer;
  const shown = last.current;
  if (!shown) return null;
  const tutorial = getChapter(shown.chapter);
  const learnMore = () => {
    const slide = shown.slide ? `&slide=${shown.slide}` : '';
    tutorialHref.current = `/tutorials/player?chapter=${shown.chapter}${slide}` as Href;
    onClose();
  };
  const onClosed = () => {
    const href = tutorialHref.current;
    tutorialHref.current = null;
    if (href) router.push(href);
  };

  return (
    <BottomSheet open={open} onClose={onClose} onClosed={onClosed} testID="page-explainer">
      <Text size="xl" bold accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
        {t(shown.titleKey)}
      </Text>
      <View style={styles.body}>
        {shown.paragraphKeys.map((key) => (
          <Text key={key} size="md" style={{ color: colors.ink2 }}>
            {t(key)}
          </Text>
        ))}
      </View>
      <View style={styles.actions}>
        {tutorial ? (
          <Pressable
            onPress={learnMore}
            accessibilityRole="button"
            style={[styles.button, styles.outlined]}
            testID="page-explainer-learn-more"
          >
            <Text size="md" bold style={{ color: colors.ink }}>
              {t('nav.learnMore')}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={[styles.button, styles.filled]}
          testID="page-explainer-close"
        >
          <Text size="md" bold style={{ color: colors.onAccent }}>
            {t('tabExplainer.close')}
          </Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
};

// P12 moves these onto useColors().
const C = COLORS.dark;

const styles = StyleSheet.create({
  title: { marginBottom: 12 },
  body: { gap: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  button: { flex: 1, minHeight: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  outlined: { borderWidth: 1, borderColor: C.helpRing },
  filled: { backgroundColor: C.accent },
});

export default PageExplainerSheet;
