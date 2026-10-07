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
// Content insets are this file's: BottomSheet draws the surface, handle and
// bottom inset only (board: 22pt sides, 12pt between blocks).

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { useColors } from '@/lib/theme/tokens';
import type { PageExplainer } from './page-registry';

export interface PageExplainerSheetProps {
  readonly explainer: PageExplainer | null;
  readonly open: boolean;
  readonly onClose: () => void;
}

const PageExplainerSheet: React.FC<PageExplainerSheetProps> = ({ explainer, open, onClose }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const wantsTutorial = useRef(false);
  // Keep the last copy while the sheet slides away after its host clears it.
  const last = useRef(explainer);
  if (explainer) last.current = explainer;
  const shown = last.current;
  if (!shown) return null;
  const learnMore = () => {
    wantsTutorial.current = true;
    onClose();
  };
  const onClosed = () => {
    if (!wantsTutorial.current) return;
    wantsTutorial.current = false;
    openTutorial(shown.chapter, shown.slide);
  };

  return (
    <BottomSheet open={open} onClose={onClose} onClosed={onClosed} testID="page-explainer">
      <View style={styles.content}>
        <Text bold accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
          {t(shown.titleKey)}
        </Text>
        <View style={styles.body}>
          {shown.paragraphKeys.map((key) => (
            <Text key={key} style={[styles.paragraph, { color: colors.ink2 }]}>
              {t(key)}
            </Text>
          ))}
        </View>
        <View style={styles.actions}>
          <Pressable
            onPress={learnMore}
            accessibilityRole="button"
            style={[styles.button, styles.outlined, { borderColor: colors.helpRing }]}
            testID="page-explainer-learn-more"
          >
            <Text size="md" bold style={{ color: colors.ink }}>
              {t('nav.learnMore')}
            </Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            style={[styles.button, { backgroundColor: colors.accent }]}
            testID="page-explainer-close"
          >
            <Text size="md" bold style={{ color: colors.onAccent }}>
              {t('tabExplainer.close')}
            </Text>
          </Pressable>
        </View>
      </View>
    </BottomSheet>
  );
};

const styles = StyleSheet.create({
  // Board: 22pt sides, 12pt between blocks; sizes set with their leading.
  content: { paddingHorizontal: 22, gap: 12 },
  title: { fontSize: 22, lineHeight: 28 },
  body: { gap: 12 },
  paragraph: { fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  button: { flex: 1, minHeight: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  outlined: { borderWidth: 1 },
});

export default PageExplainerSheet;
