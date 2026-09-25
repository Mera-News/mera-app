// ChatBugReportButton — the chat header's "Report a bug" (ux2 H). Opens the
// ordinary report form with the whole transcript attached, sent only if the
// user taps Send. Sits left of New chat, in the same round header style.

import { Button } from '@/components/ui/button';
import { hapticLight } from '@/lib/haptics';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
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
      // 36pt disc, 44pt+ touch frame, same as New chat and Close.
      hitSlop={12}
      action="default"
      className="w-9 h-9 p-0 rounded-full bg-background-100 data-[active=true]:bg-background-200"
    >
      <MaterialIcons name="bug-report" size={20} color={ICON} />
    </Button>
  );
};

export default ChatBugReportButton;
