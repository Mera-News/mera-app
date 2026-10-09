import { HelpModal } from '@/components/ui/help-modal';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAboutMeraLink } from './useAboutMeraLink';

interface AboutMeraModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * What the chat header's "?" explains. The first paragraph is the EU AI Act
 * Art. 50(1) interaction notice, one sentence in three keys joined as they
 * are: each locale carries its own spacing (ja/zh/th join with none), the
 * middle part is the link. Nested Text keeps it one sentence that wraps as
 * one; the app has no <Trans>.
 */
const AboutMeraModal: React.FC<AboutMeraModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const { onClosed, onLinkPress } = useAboutMeraLink(onClose);
  const line = { color: colors.ink2, fontSize: 16, lineHeight: 22 } as const;

  return (
    <HelpModal
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      title={t('floatingChat.aboutTitle')}
      testID="about-mera"
    >
      <View style={{ gap: 10 }}>
        <Text style={line} testID="chat-guidelines">
          {t('floatingChat.guidelinesBefore')}
          <Text
            accessibilityRole="link"
            onPress={onLinkPress}
            style={[line, { color: colors.accentText, textDecorationLine: 'underline' }]}
            testID="chat-guidelines-link"
          >
            {t('floatingChat.guidelinesLink')}
          </Text>
          {t('floatingChat.guidelinesAfter')}
        </Text>
        <Text style={line}>{t('floatingChat.mayMistakes')}</Text>
      </View>
    </HelpModal>
  );
};

export default AboutMeraModal;
