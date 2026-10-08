// Which colour "Read on <publication>" wears (owner, restoring the ux1 rule
// P9 dropped): GREEN when opening the original still gets the reader
// something readable because THIS phone can translate that language on device
// (`getArticleTranslationSupport`, which carries the iOS-version and language
// table) or the article is already in the reader's language, the neutral ink
// outline otherwise. Google Translate is always green. RN-free.

import type { TranslatableStatus } from '@/lib/translation-service';

export type ReadRouteInk = 'positive' | 'ink';

export function publisherRouteInk(status: TranslatableStatus): ReadRouteInk {
    return status === 'not-translatable' ? 'ink' : 'positive';
}
