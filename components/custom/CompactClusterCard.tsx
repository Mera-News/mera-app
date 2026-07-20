// DEPRECATED(app-rethink wave): replaced by components/custom/cards/; no live consumers.
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { NewsCluster } from '@/lib/generated/graphql-types';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';

interface CompactClusterCardProps {
    cluster: NewsCluster;
    onPress: () => void;
    timestamp?: string;
    isNew?: boolean;
}

export const CompactClusterCard: React.FC<CompactClusterCardProps> = ({
    cluster,
    onPress,
    timestamp,
    isNew = false
}) => {
    const firstArticle = cluster.articles?.articles?.[0];
    const clusterImageUrl = firstArticle?.image_url;

    const headlineTitle =
        firstArticle?.title_en_internal_only || firstArticle?.title || null;
    if (!headlineTitle) {
        console.warn('[CompactClusterCard] falling back to "News Cluster"', {
            clusterId: cluster._id,
            createdAt: cluster.createdAt,
            articleCount: cluster.articles?.articles?.length ?? 0,
            firstArticleId: firstArticle?._id,
            firstArticleTitle: firstArticle?.title,
            firstArticleTitleEn: firstArticle?.title_en_internal_only,
            firstArticleImageUrl: firstArticle?.image_url,
            firstArticleOriginalLanguage: firstArticle?.original_language_code,
        });
    }

    const formatTimestamp = (dateString?: string) => {
        if (!dateString) return 'Just now';

        try {
            const date = new Date(dateString);
            const now = new Date();
            const diffInMs = now.getTime() - date.getTime();
            const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
            const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
            const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

            if (diffInMinutes < 1) return 'Just now';
            if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
            if (diffInHours < 24) return `${diffInHours}h ago`;
            if (diffInDays < 7) return `${diffInDays}d ago`;

            return date.toLocaleDateString();
        } catch {
            return 'Recently';
        }
    };

    return (
        <Pressable onPress={onPress}>
            <Card variant="elevated" size="sm" className="mb-3 overflow-hidden rounded-xl">
                <Box className="flex-row h-32">
                    {/* Image Section - 1/4 width (25%) */}
                    <Box className="w-1/4 h-full">
                        {clusterImageUrl ? (
                            <Image
                                source={{ uri: clusterImageUrl }}
                                alt={firstArticle?.title || 'Cluster'}
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
                        {/* Top Row: Timestamp and Article count */}
                        <Box className="flex-row items-center justify-between">
                            <Box className="flex-row items-center" style={{ gap: 6 }}>
                                <Box className="flex-row items-center">
                                    <MaterialIcons
                                        name="schedule"
                                        size={12}
                                        color="#6B7280"
                                    />
                                    <Text size="xs" className="text-typography-600 ml-1">
                                        {formatTimestamp(timestamp || cluster.createdAt)}
                                    </Text>
                                </Box>
                                {__DEV__ && typeof cluster.topicConfidence === 'number' ? (
                                    <Box className="bg-amber-900/40 px-1.5 rounded">
                                        <Text size="xs" className="text-amber-300 font-mono">
                                            {cluster.topicConfidence.toFixed(3)}
                                        </Text>
                                    </Box>
                                ) : null}
                            </Box>
                        </Box>

                        {/* Headline */}
                        <Box className="flex-1 justify-center py-1">
                            <TranslatableDynamic
                                text={headlineTitle || 'News Cluster'}
                                originalText={firstArticle?.title}
                                originalLanguage={firstArticle?.original_language_code}
                                size="sm"
                                className="leading-5 font-medium"
                                numberOfLines={2}
                            />
                        </Box>
                    </Box>
                </Box>
            </Card>
        </Pressable>
    );
};

export default CompactClusterCard;
