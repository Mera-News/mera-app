import { keyboardLift } from '@/components/custom/onboarding/keyboard-lift';

describe('keyboardLift', () => {
  it('is zero with the keyboard down', () => {
    expect(keyboardLift(0, 34)).toBe(0);
  });

  it('lifts by the keyboard minus the inset the screen already pads', () => {
    expect(keyboardLift(-336, 34)).toBe(302);
  });

  it('never goes negative while the keyboard is shorter than the inset', () => {
    expect(keyboardLift(-20, 34)).toBe(0);
  });
});

describe('onboarding chat step', () => {
  it('lifts by the shared rule, not a KeyboardAvoidingView measured from a nested frame', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../../..', 'components/custom/onboarding/PersonaUpdateChatStep.tsx'), 'utf8');
    expect(src).toContain('keyboardLift(');
    expect(src).not.toMatch(/<KeyboardAvoidingView/);
  });
});

describe('onboarding guards', () => {
  it('the keyboard is dismissed right before each guard opens', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(path.resolve(__dirname, '../../../..', 'components/custom/onboarding/OnboardingWizard.tsx'), 'utf8');
    for (const guard of ['no-facts', 'no-notifications']) {
      expect(src).toMatch(new RegExp(`Keyboard\\.dismiss\\(\\);\\s*setGuard\\('${guard}'\\)`));
    }
  });
});
