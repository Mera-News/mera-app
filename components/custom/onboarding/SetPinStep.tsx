import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface SetPinStepProps {
  // Advances the wizard once the PIN is persisted.
  onDone: () => void;
}

// First onboarding step: set the mandatory local PIN. Thin wrapper over the
// shared PinSetupScreen so the wizard owns step advancement.
const SetPinStep: React.FC<SetPinStepProps> = ({ onDone }) => {
  const { t } = useTranslation();
  return (
    <PinSetupScreen
      onComplete={onDone}
      title={t('pin.onboardingTitle')}
      subtitle={t('pin.onboardingSubtitle')}
    />
  );
};

export default SetPinStep;
