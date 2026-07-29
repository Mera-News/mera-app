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
 * It is also the section's EMPTY STATE. When nothing clears the bar the section
 * still renders its title and this line, now reading "Mera read 20 headlines ·
 * none looked relevant today." — the only case where a section shows zero cards.
 * An empty section that explains itself is the point: the alternative (drop the
 * section, as fact sections do) tells the reader nothing about work Mera
 * actually did on their behalf.
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
