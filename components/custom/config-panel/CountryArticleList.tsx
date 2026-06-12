import { ArticleService } from '@/lib/article-service';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import PaginatedArticleList from './PaginatedArticleList';

interface CountryArticleListProps {
    readonly countryCode: string;
    readonly countryName: string;
    readonly onBack: () => void;
}

const CountryArticleList: React.FC<CountryArticleListProps> = ({ countryCode, countryName, onBack }) => {
    const { t } = useTranslation();
    const loadPage = useCallback(
        (after?: string) => ArticleService.getArticlesForCountry(countryCode, { first: 10, after }),
        [countryCode]
    );

    return (
        <PaginatedArticleList
            title={countryName}
            subtitle={t('sources.topHeadlines')}
            loadPage={loadPage}
            onBack={onBack}
            logScope="CountryArticleList"
        />
    );
};

export default CountryArticleList;
