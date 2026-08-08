import React from 'react';

import type { Placeholder } from '@/lib/tutorials/types';
import CardsPlaceholder from './placeholders/CardsPlaceholder';
import IconPlaceholder from './placeholders/IconPlaceholder';
import LogoPlaceholder from './placeholders/LogoPlaceholder';
import OrbitPlaceholder from './placeholders/OrbitPlaceholder';
import StepsPlaceholder from './placeholders/StepsPlaceholder';

interface ScenePlaceholderProps {
    readonly placeholder: Placeholder;
    /** Resolved copy for `{ kind: 'steps' }`; ignored by every other kind. */
    readonly stepLabels?: readonly string[];
}

/**
 * The SHIPPED visual layer for every tutorial slide — not a stopgap. This wave
 * carries no animation runtime at all, so these five kinds are what ~65 slides
 * actually look like.
 *
 * ⚠️ THIS FILE CALLS NO HOOKS, ON PURPOSE.
 *
 * `reactCompiler: true` is on. A single component that branched on
 * `placeholder.kind` *and* called `useSharedValue` would compile to conditional
 * hooks and misbehave in ways that look like a rendering glitch rather than a
 * hook violation. So: one component per kind, each owning its own shared
 * values, and this switch is a pure dispatcher that mounts exactly one of them.
 * `components/custom/MeraLogo.tsx:20-27` documents the same discipline.
 *
 * The `default` arm returns `null` rather than throwing: a slide that somehow
 * carries an unknown kind should render without a scene, never crash a chapter.
 */
const ScenePlaceholder: React.FC<ScenePlaceholderProps> = ({ placeholder, stepLabels }) => {
    switch (placeholder.kind) {
        case 'logo':
            return <LogoPlaceholder />;
        case 'icon':
            return <IconPlaceholder name={placeholder.name} />;
        case 'cards':
            return <CardsPlaceholder count={placeholder.count} />;
        case 'orbit':
            return <OrbitPlaceholder name={placeholder.name} />;
        case 'steps':
            return <StepsPlaceholder labels={stepLabels ?? []} />;
        default:
            return null;
    }
};

export default ScenePlaceholder;
