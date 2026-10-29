import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { Text } from '@/components/ui/text';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

/**
 * Under a followed story's header: says up front that a few articles may be only loosely
 * related, by design (Mera would rather show one extra than miss one), and how to remove
 * one. One line by default; Learn more opens the reason in place. Open state is per visit.
 */
const WideNetNote: React.FC = () => {
  const { t } = useTranslation();
  const styles = useStyles();
  const colors = useColors();
  const [open, setOpen] = useState(false);

  const toggle = (
    <Pressable
      testID={open ? 'story-wide-net-less' : 'story-wide-net-more'}
      onPress={() => setOpen((o) => !o)}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={styles.toggle}
    >
      <Text size="sm" style={styles.link}>
        {open ? t('trackedStories.wideNetShowLess') : t('nav.learnMore')}
      </Text>
    </Pressable>
  );

  if (!open) {
    return (
      <View style={styles.line} testID="story-wide-net">
        <MaterialIcons {...DECORATIVE_ICON_A11Y} name="info-outline" size={18} color={colors.ink3} />
        <Text size="sm" style={styles.lineText}>
          {t('trackedStories.wideNetLine')}
        </Text>
        {toggle}
      </View>
    );
  }

  return (
    <View style={styles.panel} testID="story-wide-net-open">
      <View style={styles.titleRow}>
        <MaterialIcons {...DECORATIVE_ICON_A11Y} name="info-outline" size={18} color={colors.ink2} />
        <Text size="sm" bold style={styles.title} accessibilityRole="header">
          {t('trackedStories.wideNetTitle')}
        </Text>
      </View>
      <Text size="sm" style={styles.body}>
        {t('trackedStories.wideNetBody')}
      </Text>
      <Text size="sm" style={styles.body}>
        {t('trackedStories.wideNetRemove', { action: t('trackedStories.removeMemberAction') })}
      </Text>
      {toggle}
    </View>
  );
};

const useStyles = themedStyles((c, mode) =>
  StyleSheet.create({
    line: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16 },
    lineText: { flex: 1, minWidth: 0, color: c.ink2 },
    panel: {
      marginHorizontal: 16,
      paddingHorizontal: 14,
      paddingTop: 12,
      gap: 6,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.panelBorder,
      backgroundColor: mode === 'light' ? c.panel : c.surface,
    },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { flex: 1, color: c.ink },
    body: { color: c.ink2 },
    toggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    link: { color: c.accentText },
  }),
);

export default WideNetNote;
