// The first-feed privacy card (D9): one dismissible card above the counts card. It says why Mera reads when the app
// opens, without claiming nothing leaves the phone. It stays until dismissed or until the first session in which a
// run finished is over. The session a run finished in is stamped with this process's id: the same session keeps the
// card (even when the run ended before the Feed mounted, e.g. during onboarding), a different one hides it.
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MaterialIcons } from '@expo/vector-icons';

import { GlassPanel } from '@/components/custom/GlassSurface';
import MeraLogo from '@/components/custom/MeraLogo';
import PageExplainerSheet from '@/components/custom/nav/PageExplainerSheet';
import { PAGE_META } from '@/components/custom/nav/page-registry';
import { Text } from '@/components/ui/text';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useForYouSuggestionsHydrated } from '@/lib/stores/for-you-store';
import { useForYouLastProcessingRunFinishedAt } from '@/lib/stores/selectors';
import { useColors } from '@/lib/theme/tokens';

const DISMISSED_KEY = 'feed_privacy_intro_dismissed';
const SESSION_KEY = 'feed_privacy_intro_session';
let sessionId = `${Date.now()}-${Math.random()}`;
/** Tests: start a new app session. */
export function __newFirstFeedSessionForTests(): void {
    sessionId = `${Date.now()}-${Math.random()}`;
}

/** Null until the setting and the run record are both read, so the card never flashes for a reader who is past it. */
export function useFirstFeedVisible(): [boolean, () => void] {
    const [dismissed, setDismissed] = useState<boolean | null>(null);
    // The session a run finished in: undefined until read, null when none yet.
    const [stamp, setStamp] = useState<string | null | undefined>(undefined);
    const hydrated = useForYouSuggestionsHydrated();
    const runFinishedAt = useForYouLastProcessingRunFinishedAt();

    useEffect(() => {
        let live = true;
        Promise.all([getSetting(DISMISSED_KEY), getSetting(SESSION_KEY)])
            .then(([d, s]) => {
                if (!live) return;
                setDismissed(d === '1');
                setStamp(s || null);
            })
            .catch(() => live && setDismissed(true));
        return () => {
            live = false;
        };
    }, []);

    useEffect(() => {
        if (dismissed !== false || !hydrated || stamp === undefined) return;
        if (stamp !== null && stamp !== sessionId) {
            setDismissed(true);
            void setSetting(DISMISSED_KEY, '1').catch(() => {});
        } else if (stamp === null && runFinishedAt !== null) {
            setStamp(sessionId);
            void setSetting(SESSION_KEY, sessionId).catch(() => {});
        }
    }, [dismissed, hydrated, runFinishedAt, stamp]);

    const dismiss = useCallback(() => {
        setDismissed(true);
        void setSetting(DISMISSED_KEY, '1').catch(() => {});
    }, []);
    return [dismissed === false && hydrated, dismiss];
}

const FirstFeedCard: React.FC = () => {
    const { t } = useTranslation();
    const c = useColors();
    const [visible, dismiss] = useFirstFeedVisible();
    const [explainerOpen, setExplainerOpen] = useState(false);
    if (!visible) return null;
    return (
        <View testID="first-feed-card" style={{ marginBottom: 8 }}>
            <GlassPanel radius={12} contentClassName="px-4 py-3" paper>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                    <View style={{ paddingTop: 1 }}>
                        <MeraLogo size={20} color={c.accentMark} animated={false} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18 }}>{t('feed.firstFeed.body')}</Text>
                        <Pressable
                            onPress={() => setExplainerOpen(true)}
                            accessibilityRole="link"
                            testID="first-feed-link"
                            style={{ minHeight: 44, marginVertical: -10, justifyContent: 'center', alignSelf: 'flex-start' }}
                        >
                            <Text style={{ color: c.accentText, fontSize: 14, lineHeight: 19, fontWeight: '600' }}>
                                {t('feed.firstFeed.link')}
                            </Text>
                        </Pressable>
                    </View>
                    {/* A 44pt frame pulled back into the card's padding. */}
                    <Pressable
                        onPress={dismiss}
                        accessibilityRole="button"
                        accessibilityLabel={t('feed.firstFeed.dismiss')}
                        testID="first-feed-dismiss"
                        style={{ width: 44, height: 44, margin: -12, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <MaterialIcons name="close" size={18} color={c.ink2} accessible={false} />
                    </Pressable>
                </View>
            </GlassPanel>
            {PAGE_META.feed.explainer ? (
                <PageExplainerSheet explainer={PAGE_META.feed.explainer} open={explainerOpen} onClose={() => setExplainerOpen(false)} />
            ) : null}
        </View>
    );
};

export default FirstFeedCard;
