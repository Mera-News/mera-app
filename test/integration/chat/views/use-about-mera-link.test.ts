// Seam test for useAboutMeraLink: the About Mera policy link closes the card first and opens the
// policy only once the card is fully gone (iOS will not present the in-app browser over a Modal
// still leaving). The browser is the expo-web-browser native mock from the integration setup.
import { renderHook } from '@testing-library/react-native';
import { useAboutMeraLink } from '@/components/custom/floating-chat/useAboutMeraLink';
import { CONTENT_POLICY_URL } from '@/lib/config/branding';
import { withAppLanguage } from '@/lib/web-browser-utils';

const { openBrowserAsync } = jest.requireMock('expo-web-browser') as {
  openBrowserAsync: jest.Mock;
};

const setup = () => {
  const onClose = jest.fn();
  const { result } = renderHook(() => useAboutMeraLink(onClose));
  return { onClose, link: result.current };
};

describe('useAboutMeraLink', () => {
  it('pressing the link closes the card and opens nothing yet', () => {
    const { onClose, link } = setup();
    link.onLinkPress();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openBrowserAsync).not.toHaveBeenCalled();
  });

  it('opens the policy once the card has closed after a press', () => {
    const { link } = setup();
    link.onLinkPress();
    link.onClosed();
    expect(openBrowserAsync).toHaveBeenCalledTimes(1);
    expect(openBrowserAsync).toHaveBeenCalledWith(
      withAppLanguage(CONTENT_POLICY_URL),
      expect.anything(),
    );
  });

  it('opens nothing when the card closes without a link press', () => {
    const { link } = setup();
    link.onClosed();
    expect(openBrowserAsync).not.toHaveBeenCalled();
  });

  it('a second close after one policy open opens nothing more', () => {
    const { link } = setup();
    link.onLinkPress();
    link.onClosed();
    link.onClosed();
    expect(openBrowserAsync).toHaveBeenCalledTimes(1);
  });
});
