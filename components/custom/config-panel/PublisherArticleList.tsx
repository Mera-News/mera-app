import { ArticleService } from '@/lib/article-service';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import PaginatedArticleList from './PaginatedArticleList';

interface PublisherArticleListProps {
    readonly publisherId: string;
    readonly publisherName: string;
    readonly onBack: () => void;
}

const PublisherArticleList: React.FC<PublisherArticleListProps> = ({ publisherId, publisherName, onBack }) => {
    const { t } = useTranslation();
    const loadPage = useCallback(
        (after?: string) => ArticleService.getArticlesForPublisher(publisherId, { first: 10, after }),
        [publisherId]
    );

    return (
        <PaginatedArticleList
            title={publisherName}
            subtitle={t('sources.topHeadlines')}
            loadPage={loadPage}
            onBack={onBack}
            logScope="PublisherArticleList"
        />
    );
};

export default PublisherArticleList;
