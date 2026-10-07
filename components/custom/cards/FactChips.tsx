import { getCachedFacts, setCachedFacts } from '@/components/custom/cards/facts-cache';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { getFactsForTopicTexts } from '@/lib/database/services/fact-service';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { primaryStatement } from '@/lib/stores/fact-rows-selector';
import { themedStyles, tint } from '@/lib/theme/tokens';
import React, { useEffect, useState } from 'react';

/**
 * The note box's inks (SuggestionCard board), shared by the note and these
 * chips. Dark: a neutral darkening, plain black at 25% with no hue to fight
 * the gradient behind the card; light: a faint ink wash. The AI tag is ink-2
 * so it stays subordinate to the note.
 */
export const useNoteInk = themedStyles((c, mode) => ({
    box: mode === 'dark' ? tint(c.base, 0.25) : tint(c.ink, 0.06),
    ink: c.ink,
    ai: c.ink2,
}));

/**
 * The persona facts whose topics found a suggestion (`userTopicIds`). Queried
 * on mount; the module-level LRU cache lets rows sharing a topic set skip the
 * query (A5). Shared by the fact chips and the note's waiting line.
 */
export function useMatchedFacts(topicIds: string[] | null | undefined): Fact[] {
    const [facts, setFacts] = useState<Fact[]>([]);
    // Primitive dep: `userTopicIds` is a fresh array on every render.
    const topicIdsKey = JSON.stringify(topicIds ?? []);
    useEffect(() => {
        const ids = JSON.parse(topicIdsKey) as string[];
        if (ids.length === 0) {
            setFacts([]);
            return;
        }
        const cacheKey = [...ids].sort().join(' ');
        const cached = getCachedFacts(cacheKey);
        if (cached) {
            setFacts(cached);
            return;
        }
        let cancelled = false;
        getFactsForTopicTexts(ids)
            .then((f) => {
                if (cancelled) return;
                setCachedFacts(cacheKey, f);
                setFacts(f);
            })
            .catch(() => {
                if (!cancelled) setFacts([]);
            });
        return () => {
            cancelled = true;
        };
    }, [topicIdsKey]);
    return facts;
}

/**
 * The facts a complete, note-less suggestion matched, as chips. ONE component
 * for the Feed card and the detail screen, so the two show the same chips.
 * Mount it only where the chips can appear: it queries on mount.
 */
const FactChips: React.FC<{ topicIds: string[] | null | undefined }> = ({ topicIds }) => {
    const facts = useMatchedFacts(topicIds);
    const note = useNoteInk();
    if (facts.length === 0) return null;
    return (
        <HStack className="flex-wrap justify-end" space="xs" testID="fact-chips">
            {facts.map((fact) => (
                <Box
                    key={fact.id}
                    className="px-2.5 py-1 rounded-full mb-1"
                    style={{ backgroundColor: note.box }}
                >
                    <Text size="2xs" style={{ color: note.ink, fontWeight: '600' }} numberOfLines={1}>
                        {primaryStatement(fact.statement)}
                    </Text>
                </Box>
            ))}
        </HStack>
    );
};

export default FactChips;
