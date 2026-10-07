import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import type { SourceScopeKind } from '@/lib/database/models/PublicationPreference';
import { weightToPrefKind, type PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { MaterialIcons } from '@expo/vector-icons';
import { COLORS, tint, useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { DisplayPublicationName } from '@/lib/stores/publication-display-store';
import SourceKindChip from './SourceKindChip';

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

interface KindMeta {
    readonly icon: IconName;
    readonly color: string;
    readonly labelKey: string;
    readonly labelDefault: string;
}

/** Icon + color + i18n label for each preference kind. The publication page's
 *  feed control reads this; the Sources screen says More / Fewer / Mute. */
export const PREF_KIND_META: Record<PublicationPrefKind, KindMeta> = {
    boost: { icon: 'thumb-up', color: COLORS.dark.positive, labelKey: 'publicationPrefs.kindBoost', labelDefault: 'Boost' },
    deprioritize: { icon: 'thumb-down', color: COLORS.dark.warning, labelKey: 'publicationPrefs.kindDeprioritize', labelDefault: 'Downrank' },
    mute: { icon: 'volume-off', color: COLORS.dark.negative, labelKey: 'publicationPrefs.kindMute', labelDefault: 'Mute' },
};

const KIND_ORDER: PublicationPrefKind[] = ['boost', 'deprioritize', 'mute'];
const CHOICE_LABEL = {
    boost: 'you.sources.more',
    deprioritize: 'you.sources.fewer',
    mute: 'you.sources.mute',
} as const satisfies Record<PublicationPrefKind, string>;

/**
 * source-pref P4. A SCOPE row (`scopeKind != null`) stores its human label
 * ("India") in `publication_name`, so undecorated it reads exactly like a
 * publication named "India". This chip is the only thing that tells them apart.
 */
const SCOPE_KIND_CHIPS: Record<SourceScopeKind, { key: string; default: string }> = {
    country: { key: 'publicationPrefs.scopeKindCountry', default: 'Country' },
};

/** Stable, kebab-cased testID segment for a publication name (harness/QA). */
export function normalizeForTestId(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * More / Fewer / Mute (+ Clear when something is set). Shared by an adjusted
 * row and a search result, so the two can never offer different choices.
 * A country scope can never be muted, so it gets no Mute.
 */
export const SourceKindChoices: React.FC<{
    readonly idBase: string;
    readonly current: PublicationPrefKind | null;
    readonly busy: boolean;
    readonly allowMute: boolean;
    readonly onPick: (kind: PublicationPrefKind) => void;
    readonly onClear?: () => void;
}> = ({ idBase, current, busy, allowMute, onPick, onClear }) => {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <HStack space="sm" className="items-center">
            {KIND_ORDER.filter((k) => allowMute || k !== 'mute').map((kind) => {
                const active = current === kind;
                return (
                    <Pressable
                        key={kind}
                        testID={`${idBase}-${kind}`}
                        onPress={() => onPick(kind)}
                        disabled={busy}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active, disabled: busy }}
                        accessibilityLabel={t(CHOICE_LABEL[kind])}
                        className={`flex-1 items-center justify-center rounded-full border ${active ? 'border-primary-400 bg-primary-400/15' : 'border-line'}`}
                        style={{ minHeight: 44 }}
                    >
                        <Text size="sm" style={{ color: active ? colors.accent : colors.ink, fontWeight: active ? '600' : '400' }}>
                            {t(CHOICE_LABEL[kind])}
                        </Text>
                    </Pressable>
                );
            })}
            {onClear && current ? (
                <Pressable
                    testID={`${idBase}-clear`}
                    onPress={onClear}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy }}
                    accessibilityLabel={t('publicationPrefs.clearA11y')}
                    className="items-center justify-center px-3"
                    style={{ minHeight: 44 }}
                >
                    <Text size="sm" className="text-ink-2">{t('you.sources.clear')}</Text>
                </Pressable>
            ) : null}
        </HStack>
    );
};

interface PublicationPrefRowProps {
    readonly pref: PublicationPreferenceModel;
    readonly busy: boolean;
    readonly isOpen: boolean;
    readonly onToggle: (pref: PublicationPreferenceModel) => void;
    readonly onSetKind: (pref: PublicationPreferenceModel, kind: PublicationPrefKind) => void;
    readonly onClear: (pref: PublicationPreferenceModel) => void;
}

/**
 * One adjusted publication (or country scope) on the Sources screen: the name
 * and a More / Fewer / Muted chip. Tapping opens the choices under it; the
 * screen keeps one row open at a time.
 */
const PublicationPrefRow: React.FC<PublicationPrefRowProps> = ({ pref, busy, isOpen, onToggle, onSetKind, onClear }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const currentKind = weightToPrefKind(pref.weight);
    // Scope rows are keyed by scopeValue (stable, ISO alpha-3), not the label,
    // which can collide with a real publication name.
    const idBase = pref.scopeKind != null && pref.scopeValue
        ? `pub-pref-scope-${pref.scopeKind}-${normalizeForTestId(pref.scopeValue)}`
        : `pub-pref-${normalizeForTestId(pref.publicationName)}`;
    const scopeChip = pref.scopeKind != null ? SCOPE_KIND_CHIPS[pref.scopeKind] : undefined;

    return (
        <VStack
            testID={idBase}
            className="mx-4 mb-2 px-4 py-1"
            style={{ borderRadius: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }}
        >
            <Pressable
                testID={`${idBase}-toggle`}
                onPress={() => onToggle(pref)}
                accessibilityRole="button"
                accessibilityState={{ expanded: isOpen }}
                className="flex-row items-center"
                style={{ minHeight: 44 }}
            >
                <VStack className="flex-1 mr-2" space="xs">
                    <Text size="md" className="text-ink" numberOfLines={2}>
                        {scopeChip ? pref.publicationName : <DisplayPublicationName name={pref.publicationName} />}
                    </Text>
                    {scopeChip ? (
                        <View
                            testID={`${idBase}-kind-chip`}
                            style={{ alignSelf: 'flex-start', borderRadius: 6, borderWidth: 1, borderColor: tint(colors.accent, 0.5), paddingHorizontal: 6, paddingVertical: 1 }}
                        >
                            <Text size="xs" style={{ color: colors.accent, letterSpacing: 0.3 }}>
                                {t(scopeChip.key, { defaultValue: scopeChip.default })}
                            </Text>
                        </View>
                    ) : null}
                </VStack>
                {currentKind ? <SourceKindChip kind={currentKind} testID={`${idBase}-chip`} /> : null}
                {/* Expands in place, so a down chevron, never a forward one. */}
                <MaterialIcons name={isOpen ? 'expand-less' : 'expand-more'} size={20} color={colors.ink2} style={{ marginLeft: 6 }} />
            </Pressable>
            {isOpen ? (
                <VStack space="sm" className="pb-3">
                    {currentKind === 'mute' ? (
                        <Text size="xs" className="text-ink-2">{t('notInterested.mutedPubHint')}</Text>
                    ) : null}
                    <SourceKindChoices
                        idBase={idBase}
                        current={currentKind}
                        busy={busy}
                        allowMute={pref.scopeKind == null}
                        onPick={(kind) => onSetKind(pref, kind)}
                        onClear={() => onClear(pref)}
                    />
                </VStack>
            ) : null}
        </VStack>
    );
};

export default PublicationPrefRow;
