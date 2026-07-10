import { CompactPublisherNewsCard } from '@/components/custom/CompactPublisherNewsCard';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getArticleSuggestionsByTopicTexts } from '@/lib/database/services/article-suggestion-service';
import type ArticleSuggestion from '@/lib/database/models/ArticleSuggestion';
import logger from '@/lib/logger';
import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem } from 'react-native';
import DrillDownHeader from './DrillDownHeader';

interface PersonaArticleListProps {
    readonly topicTexts: string[];
    readonly factStatement?: string;
    readonly onBack: () => void;
}

const toNewsArticle = (s: ArticleSuggestion) => ({
    _id: s.id,
    title_en_internal_only: s.titleEn ?? null,
    title: s.titleEn ?? '',
    pubDate: s.firstPubDate ?? null,
    image_url: s.imageUrl ?? null,
    publicationSource: s.publicationName
        ? { publication_name: s.publicationName, country_code: s.countryCode ?? null }
        : null,
    source_uri: s.articleUrl ?? null,
    original_language_code: s.languageCode ?? null,
    clusterConfidence: null,
});

const PersonaArticleList: React.FC<PersonaArticleListProps> = ({ topicTexts, factStatement, onBack }) => {
    const { t } = useTranslation();
    const colors = useThemeColors();
    const [articles, setArticles] = useState<ArticleSuggestion[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const hasFetched = useRef(false);

    useEffect(() => {
        if (topicTexts.length > 0 && !hasFetched.current) {
            hasFetched.current = true;
            loadArticles();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [topicTexts]);

    const loadArticles = async () => {
        try {
            setIsLoading(true);
            const suggestions = await getArticleSuggestionsByTopicTexts(topicTexts);
            setArticles(suggestions);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'PersonaArticleList', method: 'loadArticles' },
                extra: { topicTexts },
            });
        } finally {
            setIsLoading(false);
        }
    };

    const handleArticlePress = useCallback((article: ArticleSuggestion) => {
        router.push({
            pathname: '/logged-in/article-detail',
            params: { articleId: article.id },
        });
    }, []);

    const renderItem: ListRenderItem<ArticleSuggestion> = useCallback(
        ({ item }) => (
            <CompactPublisherNewsCard
                article={toNewsArticle(item) as any}
                onPress={() => handleArticlePress(item)}
            />
        ),
        [handleArticlePress],
    );

    const keyExtractor = useCallback(
        (item: ArticleSuggestion, index: number) => item.id || `article-${index}`,
        [],
    );

    return (
        <Box className="flex-1">
            <DrillDownHeader
                title={topicTexts[0] ?? t('common.articles')}
                titleContent={factStatement ? (
                    <TranslatableDynamic
                        text={factStatement}
                        size="lg"
                        className="text-typography-950 font-semibold"
                        numberOfLines={0}
                    />
                ) : undefined}
                onBack={onBack}
            />

            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : articles.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="article" size={48} color={colors.iconMuted} />
                    <Text size="md" className="text-typography-500 text-center">
                        {t('sources.noArticlesFound')}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={articles}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{ padding: 16, paddingBottom: 20 }}
                    showsVerticalScrollIndicator={false}
                />
            )}
        </Box>
    );
};

export default PersonaArticleList;
