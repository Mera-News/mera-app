// "How this page works": the row each page draws as its LIST FOOTER (only the
// page's own list knows where its end is), opening the page's explainer in
// the hint-box modal the old per-tab "?" used. The copy comes from
// PAGE_META[...].explainer; a page without one (Settings) renders nothing.
//
// The copy is a set of CLAIMS about ranking and privacy code: change that code
// and the explainer is the first thing that goes false.
//
// A modal opened from inside a tab screen is not above the tab bar and
// survives a tab switch, so it closes when the screen loses focus.

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
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, StyleSheet, View } from 'react-native';

import { pageMeta, type PageId } from './page-registry';

const GLYPH_HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

export interface HowThisPageWorksProps {
  readonly pageId: PageId;
}

const HowThisPageWorks: React.FC<HowThisPageWorksProps> = ({ pageId }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const focused = useIsFocusedSafe();
  useEffect(() => {
    if (!focused) setOpen(false);
  }, [focused]);

  const explainer = pageMeta(pageId).explainer;
  if (!explainer) return null;
  const label = t('nav.howThisPageWorks');

  return (
    <>
      {/* A hidden visual under a CHILDLESS labelled button: a glyph inside a
          button surfaces on iOS as its own StaticText. */}
      <View testID="how-this-page-works-frame" style={styles.row}>
        <View
          pointerEvents="none"
          style={[styles.visual, { borderColor: colors.trackBorder, backgroundColor: colors.surface }]}
          {...GLYPH_HIDDEN}
        >
          <MaterialIcons name="info-outline" size={20} color={colors.muted} />
          <Text size="sm" style={[styles.label, { color: colors.muted }]}>
            {label}
          </Text>
          <MaterialIcons name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'} size={20} color={colors.muted} />
        </View>
        <Pressable
          onPress={() => setOpen(true)}
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="how-this-page-works"
        />
      </View>
      <Modal isOpen={open} onClose={() => setOpen(false)} size="md">
        <ModalBackdrop />
        <ModalContent testID={`how-this-page-works-${pageId}`}>
          <ModalHeader>
            <Heading size="lg" className="text-ink" accessibilityRole="header">
              {t(explainer.titleKey)}
            </Heading>
          </ModalHeader>
          {/* Text only, so ModalBody's ScrollView holds no list. */}
          <ModalBody>
            <VStack space="md">
              {explainer.paragraphKeys.map((key) => (
                <Text key={key} size="sm" style={{ color: colors.muted }}>
                  {t(key)}
                </Text>
              ))}
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button
              className="flex-1"
              onPress={() => setOpen(false)}
              testID="how-this-page-works-close"
            >
              <ButtonText>{t('tabExplainer.close')}</ButtonText>
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  row: { minHeight: 48, marginTop: 16, marginHorizontal: 4, justifyContent: 'center' },
  visual: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  label: { flex: 1 },
});

export default HowThisPageWorks;
