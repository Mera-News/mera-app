// ChatBugReportButton — the chat header's "Report a bug" (ux2 H). Opens the
// ordinary report form with the whole transcript attached, sent only if the
// user taps Send. Sits left of New chat, in the same round header style.

import { hapticLight } from '@/lib/haptics';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { currentChatTranscript, openChatBugReport } from './chat-bug-report';
import { GlyphSafeIconButton } from './glyph-safe';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';

const ICON = 'rgb(210, 210, 210)';

const ChatBugReportButton: React.FC = () => {
  const { t } = useTranslation();
  const onPress = useCallback(() => {
    void hapticLight();
    openChatBugReport(currentChatTranscript(), t('feedback.chatAttachmentNote'));
  }, [t]);

  return (
    // A real 44pt frame around a 36pt disc, same as New chat and Close.
    <GlyphSafeIconButton
      onPress={onPress}
      accessibilityLabel={t('preferences.reportBug')}
      testID="chat-header-report-bug"
    >
      <View style={styles.disc}>
        <MaterialIcons {...DECORATIVE_ICON_A11Y} name="bug-report" size={20} color={ICON} />
      </View>
    </GlyphSafeIconButton>
  );
};

const styles = StyleSheet.create({
  disc: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgb(51, 51, 51)', // dark background-100
  },
});

export default ChatBugReportButton;
