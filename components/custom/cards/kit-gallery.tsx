// S3's section of the navx2 P2 kit gallery (app/dev-kit.tsx): every kit piece
// this area owns, in every state. Dev only; deleted in P13.
import ArticleCardBase from '@/components/custom/cards/ArticleCardBase';
import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import CardActionBar from '@/components/custom/cards/CardActionBar';
import ReasonNote, { notePendingMode, WaitingLine } from '@/components/custom/cards/ReasonNote';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { useColors } from '@/lib/theme/tokens';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

const TITLE = 'Approximately 7,000 households in Amsterdam Nieuw-West affected by power outage';
const NOTE = 'Power outage hits Nieuw-West, where you live, affecting 7,000 households directly.';
const IMAGE = 'https://picsum.photos/seed/mera-kit/800/400';

function Label({ children }: { children: string }) {
    const colors = useColors();
    return <Text style={{ color: colors.ink3, fontSize: 12, marginTop: 16, marginBottom: 6 }}>{children}</Text>;
}

function Toggle({ label, onPress }: { label: string; onPress: () => void }) {
    const colors = useColors();
    return (
        <Pressable onPress={onPress} accessibilityRole="button" style={{ paddingVertical: 10 }}>
            <Text style={{ color: colors.accentText, fontSize: 14, fontWeight: '600' }}>{label}</Text>
        </Pressable>
    );
}

/** Writing, then the note landing in the same mounted box. */
function NoteReveal() {
    const [landed, setLanded] = useState(false);
    const [key, setKey] = useState(0);
    const status = landed ? ArticleSuggestionStatus.Complete : ArticleSuggestionStatus.ReasonPending;
    const reason = landed ? NOTE : '';
    return (
        <View>
            <ReasonNote
                key={key}
                relevance={0.82}
                reason={reason}
                pendingMode={notePendingMode({ status, reason }, true)}
                maxNoteLines={4}
                reserveNoteLines={4}
                testID="kit-note-reveal"
            />
            <Toggle
                label={landed ? 'Write again' : 'Land the note'}
                onPress={() => {
                    if (landed) setKey((k) => k + 1);
                    setLanded((v) => !v);
                }}
            />
        </View>
    );
}

function Actions() {
    const [verdict, setVerdict] = useState<Verdict | null>(null);
    const [saved, setSaved] = useState(false);
    const flip = (v: Verdict) => setVerdict((cur) => (cur === v ? null : v));
    return (
        <CardActionBar
            verdict={verdict}
            saved={saved}
            onLike={() => flip('like')}
            onDislike={() => flip('dislike')}
            onAskMera={() => {}}
            onToggleSave={() => setSaved((s) => !s)}
            onShare={() => {}}
            onOverflow={() => {}}
        />
    );
}

function Menu() {
    const menu = useArticleMenu({
        subject: {
            origin: 'article',
            surface: 'detail',
            articleId: 'kit-article',
            title: TITLE,
            publicationName: 'Het Parool',
            countryCode: 'NL',
        },
        onCheckFacts: () => true,
    });
    return (
        <View>
            <Toggle label="Open the ••• menu" onPress={menu.open} />
            {menu.element}
        </View>
    );
}

function Halo() {
    const [halo, setHalo] = useState(true);
    return (
        <View>
            <ArticleCardBase
                imageUrl={IMAGE}
                titleEnglish={TITLE}
                publicationName="Het Parool"
                languageCode="nl"
                countryCode="NL"
                showRecency={false}
                halo={halo}
            />
            <Toggle label={halo ? 'Mark seen (halo fades)' : 'Unseen again'} onPress={() => setHalo((h) => !h)} />
        </View>
    );
}

export default function KitGallery() {
    return (
        <View testID="kit-cards">
            <Label>Note being written: one fact, several facts, none</Label>
            <WaitingLine facts={['Lives in Nieuw-West, Amsterdam']} />
            <View style={{ height: 8 }} />
            <WaitingLine facts={['Lives in Nieuw-West, Amsterdam', 'Works as a nurse']} />
            <View style={{ height: 8 }} />
            <WaitingLine facts={[]} />

            <Label>Note box: writing, then landing (reveal)</Label>
            <NoteReveal />

            <Label>Note box: not yet, and a note on the detail page</Label>
            <ReasonNote relevance={0.5} reason="" pendingMode="not-yet" reserveNoteLines={4} />
            <View style={{ height: 8 }} />
            <ReasonNote relevance={0.82} reason={NOTE} />

            <Label>Action row: tap Like, Not for me, Save</Label>
            <Actions />

            <Label>Compact cards: plain, Opened, You came from here, timeLabel</Label>
            <ArticleCompactCardBase
                imageUrl={IMAGE}
                titleEnglish="Liander restores power to most of Nieuw-West"
                pubDate={new Date(Date.now() - 2 * 3600_000).toISOString()}
                languageCode="nl"
                countryCode="NL"
                publicationName="NOS"
            />
            <ArticleCompactCardBase
                titleEnglish="Outage hits trams on line 17"
                pubDate={new Date(Date.now() - 6 * 3600_000).toISOString()}
                languageCode="nl"
                countryCode="NL"
                publicationName="AT5"
                statusLabel="Opened"
            />
            <ArticleCompactCardBase
                imageUrl={IMAGE}
                titleEnglish={TITLE}
                pubDate={new Date(Date.now() - 3600_000).toISOString()}
                languageCode="nl"
                countryCode="NL"
                publicationName="Het Parool"
                statusLabel="You came from here"
                timeLabel="Opened today"
            />

            <Label>New-card halo</Label>
            <Halo />

            <Label>••• menu: Fact check, Follow, the publisher, Support</Label>
            <Menu />
        </View>
    );
}
