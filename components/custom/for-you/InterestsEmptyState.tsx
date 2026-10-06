// Interests, before Mera knows any: say so, and offer three starters. A
// starter opens the Mera chat with its text in the COMPOSER (never sent): the
// reader finishes the sentence. The chat is the Interests page's own (persona
// agent, fact editing), the same one the Mera button opens here.

import { chatContextFor } from '@/components/custom/mera-button/mera-pages';
import { openMeraChat } from '@/components/custom/mera-button/open-mera-chat';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';


const InterestsEmptyState: React.FC = () => {
  const { t } = useTranslation();
  const starters = [
    { id: 'home', label: t('interests.chipHome'), draft: t('interests.draftHome') },
    { id: 'work', label: t('interests.chipWork'), draft: t('interests.draftWork') },
    { id: 'team', label: t('interests.chipTeam'), draft: t('interests.draftTeam') },
  ];
  return (
    <View style={styles.wrap} testID="interests-empty">
      <Text size="lg" bold className="text-white text-center" accessibilityRole="header">
        {t('interests.emptyTitle')}
      </Text>
      <Text size="md" className="text-gray-300 text-center">
        {t('interests.emptyBody')}
      </Text>
      <View style={styles.chips}>
        {starters.map((s) => (
          <Pressable
            key={s.id}
            onPress={() => openMeraChat(chatContextFor('interests'), { draft: s.draft })}
            accessibilityRole="button"
            accessibilityLabel={s.label}
            testID={`interests-starter-${s.id}`}
            style={styles.chip}
          >
            <Text size="sm" className="text-white">
              {s.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 48, paddingBottom: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 8 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(231,138,83,0.6)',
    justifyContent: 'center',
  },
});

export default InterestsEmptyState;
