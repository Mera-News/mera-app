import { HelpModal } from '@/components/ui/help-modal';
import { Text } from '@/components/ui/text';
import { CONTENT_POLICY_URL } from '@/lib/config/branding';
import { useColors } from '@/lib/theme/tokens';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

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
  // The policy opens once the card is fully gone: iOS will not present the
  // in-app browser over a Modal still leaving.
  const wantsPolicy = useRef(false);
  const line = { color: colors.ink2, fontSize: 16, lineHeight: 22 } as const;

  return (
    <HelpModal
      open={open}
      onClose={onClose}
      onClosed={() => {
        if (!wantsPolicy.current) return;
        wantsPolicy.current = false;
        void openInAppBrowser(withAppLanguage(CONTENT_POLICY_URL));
      }}
      title={t('floatingChat.aboutTitle')}
      testID="about-mera"
    >
      <View style={{ gap: 10 }}>
        <Text style={line} testID="chat-guidelines">
          {t('floatingChat.guidelinesBefore')}
          <Text
            accessibilityRole="link"
            onPress={() => {
              wantsPolicy.current = true;
              onClose();
            }}
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
