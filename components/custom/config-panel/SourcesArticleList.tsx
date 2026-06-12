import { ArticleService } from '@/lib/article-service';
import React, { useCallback } from 'react';
import PaginatedArticleList from './PaginatedArticleList';

interface SourcesArticleListProps {
    readonly title: string;
    readonly publisherName?: string;
    readonly publicationSourceId: string;
    readonly onBack: () => void;
}

const SourcesArticleList: React.FC<SourcesArticleListProps> = ({ title, publisherName, publicationSourceId, onBack }) => {
    const loadPage = useCallback(
        (after?: string) =>
            ArticleService.getArticlesForPublicationSource(publicationSourceId, { first: 10, after }),
        [publicationSourceId]
    );

    return (
        <PaginatedArticleList
            title={title}
            subtitle={publisherName}
            loadPage={loadPage}
            onBack={onBack}
            logScope="SourcesArticleList"
        />
    );
};

export default SourcesArticleList;
