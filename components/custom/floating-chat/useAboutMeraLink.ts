import { CONTENT_POLICY_URL } from '@/lib/config/branding';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { useRef } from 'react';

export function useAboutMeraLink(onClose: () => void) {
  // The policy opens once the card is fully gone: iOS will not present the
  // in-app browser over a Modal still leaving.
  const wantsPolicy = useRef(false);
  const onClosed = () => {
    if (!wantsPolicy.current) return;
    wantsPolicy.current = false;
    void openInAppBrowser(withAppLanguage(CONTENT_POLICY_URL));
  };
  const onLinkPress = () => {
    wantsPolicy.current = true;
    onClose();
  };
  return { onClosed, onLinkPress };
}
