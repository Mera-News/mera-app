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

const MUTED = 'rgb(212, 212, 212)';

export interface HowThisPageWorksProps {
  readonly pageId: PageId;
}

const HowThisPageWorks: React.FC<HowThisPageWorksProps> = ({ pageId }) => {
  const { t } = useTranslation();
  // Keys come from the registry table: a computed lookup, not a literal.
  const tKey = t as unknown as (key: string) => string;
  const [open, setOpen] = useState(false);
  const focused = useIsFocusedSafe();
  useEffect(() => {
    if (!focused) setOpen(false);
  }, [focused]);

  const explainer = pageMeta(pageId).explainer;
  if (!explainer) return null;
  // Typed t() once the navx P1 copy is spliced.
  const label = tKey('nav.howThisPageWorks');

  return (
    <>
      {/* A hidden visual under a CHILDLESS labelled button: a glyph inside a
          button surfaces on iOS as its own StaticText. */}
      <View testID="how-this-page-works-frame" style={styles.row}>
        <View pointerEvents="none" style={styles.visual} {...GLYPH_HIDDEN}>
          <MaterialIcons name="info-outline" size={20} color={MUTED} />
          <Text size="sm" style={styles.label}>
            {label}
          </Text>
          <MaterialIcons name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'} size={20} color={MUTED} />
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
            <Heading size="lg" className="text-white" accessibilityRole="header">
              {tKey(explainer.titleKey)}
            </Heading>
          </ModalHeader>
          {/* Text only, so ModalBody's ScrollView holds no list. */}
          <ModalBody>
            <VStack space="md">
              {explainer.paragraphKeys.map((key) => (
                <Text key={key} size="sm" style={{ color: MUTED }}>
                  {tKey(key)}
                </Text>
              ))}
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button
              variant="outline"
              className="flex-1 border-white/30"
              onPress={() => setOpen(false)}
              testID="how-this-page-works-close"
            >
              <ButtonText className="text-white">{t('tabExplainer.close')}</ButtonText>
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
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    gap: 10,
  },
  label: { flex: 1, color: MUTED },
});

export default HowThisPageWorks;
