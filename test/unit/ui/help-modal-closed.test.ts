import { closedOn } from '@/components/ui/help-modal/closed-on';

// HelpModal's `onClosed` opens what the card pointed to (the in-app browser, a tutorial, a
// second Modal). On iOS it must wait for the Modal's real dismissal: presented earlier, the
// browser lands on the leaving Modal's view controller and UIKit keeps that Modal, invisible,
// over the whole app (the World explainer's sources link froze the app).
describe('closedOn', () => {
  it('waits for the native dismissal on iOS', () => {
    expect(closedOn('ios')).toBe('dismiss');
  });

  it('uses the fade end elsewhere', () => {
    expect(closedOn('android')).toBe('fadeEnd');
    expect(closedOn('web')).toBe('fadeEnd');
  });
});
