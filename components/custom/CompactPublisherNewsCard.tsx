import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { NewsArticle } from '@/lib/generated/graphql-types';
import React from 'react';

interface CompactPublisherNewsCardProps {
    article: NewsArticle;
    onPress: () => void;
    hideSource?: boolean;
}

export const CompactPublisherNewsCard: React.FC<CompactPublisherNewsCardProps> = ({
    article,
    onPress,
    hideSource = false,
}) => {
    // Extract domain from source_uri as fallback
    const extractDomain = (url: string): string => {
        try {
            const match = url.match(/^https?:\/\/(?:www\.)?([^\/]+)/);
            if (match && match[1]) {
                return match[1].replace(/\.(com|org|net|edu|gov|co\.uk|co|io|ai)$/i, '');
            }
            return url;
        } catch {
            return url;
        }
    };

    const publisherName = article.publicationSource?.publication_name
        || (article.source_uri ? extractDomain(article.source_uri) : 'Source');
    const countryCode = article.publicationSource?.country_code ?? null;

    return (
        <Pressable onPress={onPress}>
            <Card variant="elevated" size="sm" className="mb-3 overflow-hidden rounded-xl">
                <Box className="flex-row h-24">
                    {/* Image Section - 1/4 width (25%) */}
                    <Box className="w-1/4 h-full">
                        {article.image_url ? (
                            <Image
                                source={{ uri: article.image_url }}
                                alt={article.title}
                                className="w-full h-full"
                                resizeMode="cover"
                            />
                        ) : (
                            <Image
                                source={require('@/assets/images/news_card_placeholder_image.jpg')}
                                alt="News placeholder"
                                className="w-full h-full"
                                resizeMode="cover"
                            />
                        )}
                    </Box>

                    {/* Content Section - 3/4 width (75%) */}
                    <Box className="flex-1 flex-col px-3 py-2">
                        {/* Top Row: 4-item meta row + optional DEV cluster confidence */}
                        <Box className="h-1/4 flex-row items-center" style={{ gap: 6 }}>
                            <Box className="flex-1">
                                <ArticleMetaRow
                                    pubDate={article.pubDate}
                                    languageCode={article.original_language_code}
                                    publicationName={hideSource ? null : publisherName}
                                    countryCode={countryCode}
                                    variant="card"
                                />
                            </Box>
                            {__DEV__ && typeof article.clusterConfidence === 'number' ? (
                                <Box className="bg-amber-900/40 px-1.5 rounded">
                                    <Text size="xs" className="text-amber-300 font-mono">
                                        {article.clusterConfidence.toFixed(2)}
                                    </Text>
                                </Box>
                            ) : null}
                        </Box>

                        {/* Headline - 3/4 height */}
                        <Box className="flex-1 justify-center">
                            <TranslatableDynamic
                                text={article.title_en_internal_only || article.title}
                                originalText={article.title}
                                originalLanguage={article.original_language_code}
                                size="md"
                                className="leading-5 font-medium"
                                numberOfLines={3}
                            />
                        </Box>
                    </Box>
                </Box>
            </Card>
        </Pressable>
    );
};

export default CompactPublisherNewsCard;
