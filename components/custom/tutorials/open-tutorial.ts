import { router, type Href } from 'expo-router';

import type { ChapterId } from '@/lib/tutorials/types';

/**
 * Opens a tutorial chapter in the reader, at one slide when given: what every
 * page's ? "Learn more" and every empty state's "Learn about X" call. A direct
 * open ignores the advanced lock (that only shapes the menu). An unknown slide
 * id opens the chapter's first slide.
 */
export function openTutorial(chapter: ChapterId, slide?: string): void {
    router.push({
        pathname: '/tutorials/player',
        params: slide ? { chapter, slide } : { chapter },
    } as Href);
}
