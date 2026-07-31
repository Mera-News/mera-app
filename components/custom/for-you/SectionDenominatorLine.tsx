import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface SectionDenominatorLineProps {
  /** How many headlines Mera read for this scope inside the publication window,
   *  whether or not they cleared the relevance bar. */
  read: number;
  /** How many of them actually render in this section. */
  shown: number;
}

/**
 * The one line of plain text under a headline section's title:
 * "Mera read 20 headlines · 3 worth your time."
 *
 * It is NO LONGER an empty state. A headline section with zero cards is now
 * dropped entirely (fact-rows-selector step 5b), matching fact sections — so
 * `shown` should always be > 0 here and the `…None` branch below is an
 * unreachable guard, kept only so a future change that reintroduces empty
 * sections degrades to a sentence rather than a blank line. The `…None` strings
 * are retained in all 20 locales for the same reason; do not treat their
 * presence as evidence the state is reachable.
 *
 * Deliberately TEXT, not a control — no badge, no pill, no stepper. Simplifying
 * an existing surface is free; adding visual complexity to it has to be earned,
 * and a sentence carries this without adding a single new affordance.
 */
const SectionDenominatorLine: React.FC<SectionDenominatorLineProps> = ({ read, shown }) => {
  const { t } = useTranslation();
  const label =
    shown > 0
      ? t('forYou.headlineDenominator', { count: read, shown })
      : t('forYou.headlineDenominatorNone', { count: read });
  return (
    <Text
      testID="dashboard-section-denominator"
      size="xs"
      className="text-typography-500 px-3 pb-2"
    >
      {label}
    </Text>
  );
};

export default SectionDenominatorLine;
