// The "?" in a tab's header. Owns its own open state and mounts the sheet, so
// placing it is one line in any header:
//
//   <TabExplainerButton tab="explore" testID="explore-explainer-open" />
//
// 44pt target, labelled, and colour in `style` so it cannot be inverted by the
// dark ramp. The target is a REAL 44pt frame pulled back to the 24pt glyph's
// footprint by a -10 margin, not hitSlop: a slop-only button measured 24x24 on
// device. The negative margin keeps the glyph where it was and stops any
// header row from reflowing. A STATIC style, never a function (the
// css-interop wrapper drops function styles on device).

import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import TabExplainerSheet, { type ExplainedTab } from './TabExplainerSheet';

const GLYPH = 24;
const TARGET = 44;
const TARGET_STYLE = {
  width: TARGET,
  height: TARGET,
  margin: -(TARGET - GLYPH) / 2,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

export interface TabExplainerButtonProps {
  readonly tab: ExplainedTab;
  /** `{surface}-explainer-open`, per the testID convention. */
  readonly testID: string;
}

const TabExplainerButton: React.FC<TabExplainerButtonProps> = ({ tab, testID }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The sheet renders inside the tab's screen, not above the tab bar, so it
  // survives a tab switch and was waiting open when the reader came back.
  // Close it whenever the tab loses focus. The safe variant, because a header
  // can render outside a navigator (tests, a standalone route).
  const focused = useIsFocusedSafe();
  useEffect(() => {
    if (!focused) setOpen(false);
  }, [focused]);
  return (
    <>
      {/* The frame holds the glyph; a CHILDLESS labelled button is laid over
          it. A glyph inside a button surfaced on iOS as its own StaticText. */}
      <View style={TARGET_STYLE} testID={`${testID}-frame`}>
        <MaterialIcons
          name="help-outline"
          size={GLYPH}
          color="rgb(212, 212, 212)"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
        <Pressable
          onPress={() => setOpen(true)}
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={t('tabExplainer.openA11y')}
          testID={testID}
        />
      </View>
      <TabExplainerSheet tab={tab} isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default TabExplainerButton;
