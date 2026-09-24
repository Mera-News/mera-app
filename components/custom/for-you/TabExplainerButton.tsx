// The "?" in a tab's header. Owns its own open state and mounts the sheet, so
// placing it is one line in any header:
//
//   <TabExplainerButton tab="explore" testID="explore-explainer-open" />
//
// 44pt target (a 24pt glyph plus hitSlop), labelled, and colour in `style` so
// it cannot be inverted by the dark ramp.

import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import TabExplainerSheet, { type ExplainedTab } from './TabExplainerSheet';

const GLYPH = 24;
const HIT_SLOP = (44 - GLYPH) / 2;

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
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={t('tabExplainer.openA11y')}
        testID={testID}
      >
        <MaterialIcons name="help-outline" size={GLYPH} color="rgb(212, 212, 212)" />
      </Pressable>
      <TabExplainerSheet tab={tab} isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default TabExplainerButton;
