// The ONE page for a fact, opened from the Feed's sectioned headers (Feed
// stack) and from Profile > Facts (You stack).
//
// P2 contract stub: the shape callers code against. Until the P7 page lands it
// renders the existing one-interest screen, so routing to it changes nothing.
import FactFeedScreen from '@/components/custom/for-you/FactFeedScreen';
import React from 'react';

export interface FactPageProps {
    readonly factId: string;
    /** Which stack opened it: the Feed shows the Next interest footer and
     *  starts on Recent articles; You starts on Topics. */
    readonly from: 'feed' | 'you';
    /** Title shown before the facts load (no flash). */
    readonly statement?: string;
    /** Arrived through the previous fact's Next footer (Feed only). */
    readonly arrivedFromNext?: boolean;
}

const FactPage: React.FC<FactPageProps> = ({ factId, statement = '', arrivedFromNext = false }) => (
    <FactFeedScreen factId={factId} statement={statement} arrivedFromNext={arrivedFromNext} />
);

export default FactPage;
