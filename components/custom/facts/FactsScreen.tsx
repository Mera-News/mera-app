import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { openMeraChat } from '@/components/custom/mera-button/open-mera-chat';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Group, Row } from '@/components/custom/you/rows';
import { useActiveTopicTexts, useHubFacts } from '@/components/custom/you/use-hub-data';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { openFactPage } from './open-fact-page';
import { sentenceCase } from './sentence-case';

const FactRow: React.FC<{ readonly fact: Fact }> = ({ fact }) => {
    const { t } = useTranslation();
    const count = useActiveTopicTexts(fact.id).length;
    return (
        <Row
            testID={`facts-row-${fact.id}`}
            title={sentenceCase(fact.statement)}
            translatable
            titleLines={3}
            value={t('you.profile.topicCount', { count })}
            onPress={() => openFactPage(fact)}
        />
    );
};

/**
 * Profile > Facts (FinalProfile #5): facts only, newest first, each with its
 * topic count, each opening the fact page (where topics, deleting and turning
 * things down live). Add a fact opens the Mera chat.
 */
const FactsScreen: React.FC<{ readonly onBack: () => void }> = ({ onBack }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const facts = useHubFacts();
    const addFact = () => openMeraChat({ kind: 'persona' });

    return (
        <View style={{ flex: 1 }}>
            <DrillDownHeader title={t('facts.screenTitle')} onBack={onBack} />
            {facts === null ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <Spinner size="large" />
                </View>
            ) : facts.length === 0 ? (
                <ForYouEmptyState
                    testID="facts-empty"
                    animationId="facts-a-fact-is"
                    body={t('you.profile.factsEmpty')}
                    action={{ label: t('nav.learnMore'), onPress: () => openTutorial('facts'), testID: 'facts-empty-learn' }}
                />
            ) : (
                <ScrollView
                    testID="facts-list"
                    showsVerticalScrollIndicator={false}
                    onScroll={notifyScrollTick}
                    onContentSizeChange={notifyScrollTick}
                    scrollEventThrottle={16}
                    contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: 120, gap: 14 }}
                >
                    <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginHorizontal: 4 }}>
                        {t('facts.screenSubtitle')}
                    </Text>
                    <Group>
                        {facts.map((fact) => (
                            <FactRow key={fact.id} fact={fact} />
                        ))}
                    </Group>
                    <Pressable
                        testID="facts-add"
                        onPress={addFact}
                        accessibilityRole="button"
                        accessibilityLabel={t('facts.addFact')}
                        style={{
                            alignSelf: 'center',
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                            height: 44,
                            paddingHorizontal: 18,
                            borderRadius: 999,
                            borderWidth: 1,
                            borderColor: colors.trackBorder,
                        }}
                    >
                        <MaterialIcons name="add" size={18} color={colors.ink} />
                        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}>{t('facts.addFact')}</Text>
                    </Pressable>
                </ScrollView>
            )}
        </View>
    );
};

export default FactsScreen;
