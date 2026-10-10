import type TrackedStoryModel from '@/lib/database/models/TrackedStory';
import { observeActive } from '@/lib/database/services/tracked-story-service';
import { toastManager } from '@/lib/toast-manager';
import { deleteTrackedStoryById } from '@/lib/tracking/track-actions';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The Stories page's state: the live followed-story list, the menu and confirm
 *  targets, unfollowing, and the one AI line under the rows. */
export function useTrackedStoriesScreen() {
    const { t } = useTranslation();
    const [stories, setStories] = useState<TrackedStoryModel[]>([]);
    const [menuTarget, setMenuTarget] = useState<TrackedStoryModel | null>(null);
    const [confirmTarget, setConfirmTarget] = useState<TrackedStoryModel | null>(null);
    const stopPicked = useRef<TrackedStoryModel | null>(null);

    useEffect(() => {
        const sub = observeActive().subscribe({
            next: (rows) => setStories(rows),
            error: () => setStories([]),
        });
        return () => sub.unsubscribe();
    }, []);

    const openTimeline = useCallback((story: TrackedStoryModel) => {
        router.push({ pathname: '/logged-in/story-timeline', params: { trackedStoryId: story.id } });
    }, []);

    const handleConfirmUntrack = useCallback(async () => {
        if (!confirmTarget) return;
        const id = confirmTarget.id;
        setConfirmTarget(null);
        // deleteTrackedStoryById, not untrackStory: the latter leaves the linked
        // TOPIC active, so the story's coverage kept being fetched.
        const deleted = await deleteTrackedStoryById(id);
        // The live query drops the row on success; on failure say why it stayed.
        if (!deleted) toastManager.showError(t('errors.somethingWentWrong'), t('trackedStories.deleteFailed'));
    }, [confirmTarget, t]);

    // EU AI Act Art. 50 transparency: one line under the rows. "All" only
    // when every title on screen is AI-written; a story followed seconds ago
    // still shows its own title while its headline is written. A topic-text
    // title counts as AI-written too (owner), as each row already labels it.
    const llmCount = stories.filter((s) => !!(s.llmHeadline ?? s.topicText)).length;
    const aiNote =
        llmCount === 0
            ? null
            : llmCount === stories.length
              ? t('aiDisclosure.allStoryTitles')
              : t('aiDisclosure.listNote');

    return {
        stories,
        menuTarget,
        setMenuTarget,
        confirmTarget,
        setConfirmTarget,
        stopPicked,
        openTimeline,
        handleConfirmUntrack,
        aiNote,
    };
}
