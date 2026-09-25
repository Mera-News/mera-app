// ChatBugReportButton — the chat header's "Report a bug" (ux2 H). Opens the
// ordinary report form with the whole transcript attached, sent only if the
// user taps Send. Sits left of New chat, in the same round header style.

import { Button } from '@/components/ui/button';
import { hapticLight } from '@/lib/haptics';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { currentChatTranscript, openChatBugReport } from './chat-bug-report';

const ICON = 'rgb(210, 210, 210)';

const ChatBugReportButton: React.FC = () => {
  const { t } = useTranslation();
  const onPress = useCallback(() => {
    void hapticLight();
    openChatBugReport(currentChatTranscript(), t('feedback.chatAttachmentNote'));
  }, [t]);

  return (
    <Button
      onPress={onPress}
      accessibilityLabel={t('preferences.reportBug')}
      // A 44pt frame around a 36pt disc, same as New chat and Close.
      action="default"
      className="w-11 h-11 p-0 rounded-full bg-transparent items-center justify-center"
    >
      <View style={styles.disc}>
        <MaterialIcons name="bug-report" size={20} color={ICON} />
      </View>
    </Button>
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
