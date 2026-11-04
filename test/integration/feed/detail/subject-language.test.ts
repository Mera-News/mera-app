// A feedback subject carries the article's language, or the bug report loses it (MERA-APP-99).
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveDetailFeedbackSubject } from '@/components/custom/news-detail/detail-feedback-context';
import type { NewsArticle } from '@/lib/generated/graphql-types';

describe('the article language on a feedback subject', () => {
    it('reaches the subject of an article with no local row', async () => {
        const { subject } = await resolveDetailFeedbackSubject({
            articleId: 'no-local-row',
            title: 'A story',
            article: { original_language_code: 'nl' } as NewsArticle,
        });
        expect(subject.languageCode).toBe('nl');
    });

    // These subjects are literals inside large screens, so a render would pin far more than this.
    it.each([
        ['components/custom/news-detail/ArticleDetailScreen.tsx', 'languageCode: article.original_language_code'],
        ['components/custom/news-detail/ArticleSuggestionScreen.tsx', 'languageCode: suggestion.language_code'],
        ['components/custom/cards/ArticleStandaloneCompactCard.tsx', 'languageCode: article.original_language_code'],
    ])('%s sets it beside the country', (file, line) => {
        expect(readFileSync(join(process.cwd(), file), 'utf8')).toContain(line);
    });
});
