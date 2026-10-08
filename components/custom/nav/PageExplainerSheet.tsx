// A page's explainer: the help card the ? in the tab header opens, growing
// out of that ? (HelpModal; the ? marks itself with `markHelpOrigin`). The
// page's paragraphs, then Learn more (outlined, opens the tutorial chapter;
// absent when the page names none) and Got it (filled orange). Got it, the X, a scrim tap or Back closes it.
//
// The surface, title, X, scrim and motion are HelpModal's; this file is only
// the content. A card opened from inside a tab survives a tab switch, so its
// host (TabPages) closes it on blur. Learn more closes the card and pushes the
// tutorial only once it is fully gone (`onClosed`): an RN Modal paints above a
// root push.

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { HelpModal } from '@/components/ui/help-modal';
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
    if (shown.chapter) openTutorial(shown.chapter, shown.slide);
  };

  return (
    <HelpModal
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      title={t(shown.titleKey)}
      testID="page-explainer"
    >
      <View style={styles.content}>
        <View style={styles.body}>
          {shown.paragraphKeys.map((key) => (
            <Text key={key} style={[styles.paragraph, { color: colors.ink2 }]}>
              {t(key)}
            </Text>
          ))}
        </View>
        <View style={styles.actions}>
          {shown.chapter ? (
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
          ) : null}
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
    </HelpModal>
  );
};

const styles = StyleSheet.create({
  // 12pt between blocks; sizes set with their leading. The card owns the sides.
  content: { gap: 12 },
  body: { gap: 12 },
  paragraph: { fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  button: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlined: { borderWidth: 1 },
});

export default PageExplainerSheet;
