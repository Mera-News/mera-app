import { getCachedFacts, setCachedFacts } from '@/components/custom/cards/facts-cache';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { getFactsForTopicTexts } from '@/lib/database/services/fact-service';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { reasonBoxColors } from '@/lib/relevance-utils';
import React, { useEffect, useState } from 'react';

/**
 * The facts a complete, note-less suggestion matched, as chips. ONE component
 * for the Feed card and the detail screen, so the two show the same chips.
 * Mount it only where the chips can appear: it queries on mount, and the
 * module-level LRU cache lets rows sharing a topic set skip the query (A5).
 */
const FactChips: React.FC<{ topicIds: string[] | null | undefined }> = ({ topicIds }) => {
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

    if (facts.length === 0) return null;
    return (
        <HStack className="flex-wrap justify-end" space="xs" testID="fact-chips">
            {facts.map((fact) => (
                <Box
                    key={fact.id}
                    className="px-2.5 py-1 rounded-full mb-1"
                    style={{ backgroundColor: reasonBoxColors.backgroundColor }}
                >
                    <Text size="2xs" style={{ color: reasonBoxColors.textColor, fontWeight: '600' }} numberOfLines={1}>
                        {fact.statement}
                    </Text>
                </Box>
            ))}
        </HStack>
    );
};

export default FactChips;
