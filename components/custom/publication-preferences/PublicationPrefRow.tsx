import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import type { SourceScopeKind } from '@/lib/database/models/PublicationPreference';
import { weightToPrefKind, type PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

interface KindMeta {
    readonly icon: IconName;
    readonly color: string;
    readonly labelKey: string;
    readonly labelDefault: string;
}

/** Icon + color + i18n label for each preference kind (shared badge/selector look). */
export const PREF_KIND_META: Record<PublicationPrefKind, KindMeta> = {
    boost: { icon: 'thumb-up', color: '#10b981', labelKey: 'publicationPrefs.kindBoost', labelDefault: 'Boost' },
    deprioritize: { icon: 'thumb-down', color: '#f59e0b', labelKey: 'publicationPrefs.kindDeprioritize', labelDefault: 'Downrank' },
    mute: { icon: 'volume-off', color: '#ef4444', labelKey: 'publicationPrefs.kindMute', labelDefault: 'Mute' },
};

const KIND_ORDER: PublicationPrefKind[] = ['boost', 'deprioritize', 'mute'];

/**
 * source-pref P4. A SCOPE row (`scopeKind != null`) stores its human label
 * ("India") in `publication_name` so the row renders with no new plumbing —
 * but that means, undecorated, it reads exactly like a publication named
 * "India". This chip is the only thing that tells them apart. Same visual
 * language as `SUPPRESSION_KIND_CHIPS` in
 * `components/custom/floating-chat/ProposalCard.tsx` (accent pill, xs text).
 * Only `'country'` exists today (see `SourceScopeKind`).
 */
const SCOPE_KIND_CHIPS: Record<SourceScopeKind, { key: string; default: string }> = {
    country: { key: 'publicationPrefs.scopeKindCountry', default: 'Country' },
};
const CHIP_ACCENT = 'rgb(231, 138, 83)';

/** Stable, kebab-cased testID segment for a publication name (harness/QA). */
function normalizeForTestId(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface PublicationPrefRowProps {
    readonly pref: PublicationPreferenceModel;
    readonly busy: boolean;
    readonly onSetKind: (pref: PublicationPreferenceModel, kind: PublicationPrefKind) => void;
    readonly onClear: (pref: PublicationPreferenceModel) => void;
}

/**
 * One publication (or source-scope) preference row: the display name, a 3-way
 * kind selector (boost / downrank / mute — the active chip doubles as the
 * current-kind badge), and a clear affordance that retires the preference.
 * Named-publication rows route through the persona-action executor
 * (change-logged); scope rows are handled by the parent screen — see its
 * `TODO(source-pref P3)` for why they don't yet.
 */
const PublicationPrefRow: React.FC<PublicationPrefRowProps> = ({ pref, busy, onSetKind, onClear }) => {
    const { t } = useTranslation();
    const currentKind = weightToPrefKind(pref.weight);
    // Scope rows are keyed by scopeValue (stable, ISO alpha-3), not the label —
    // the label is a free-text display string that can collide with a real
    // publication name (e.g. a scope "India" and a publication called "India"
    // would otherwise mint the same testID prefix).
    const idBase = pref.scopeKind != null && pref.scopeValue
        ? `pub-pref-scope-${pref.scopeKind}-${normalizeForTestId(pref.scopeValue)}`
        : `pub-pref-${normalizeForTestId(pref.publicationName)}`;
    const scopeChip = pref.scopeKind != null ? SCOPE_KIND_CHIPS[pref.scopeKind] : undefined;

    return (
        <VStack testID={idBase} className="px-4 py-3 border-b border-gray-800" space="sm">
            <HStack className="items-center justify-between">
                {scopeChip ? (
                    <VStack className="flex-1 mr-2" space="xs">
                        <Text size="md" className="text-white capitalize" numberOfLines={2}>
                            {pref.publicationName}
                        </Text>
                        <View
                            testID={`${idBase}-kind-chip`}
                            style={{
                                alignSelf: 'flex-start',
                                borderRadius: 6,
                                borderWidth: 1,
                                borderColor: 'rgba(231, 138, 83, 0.5)',
                                paddingHorizontal: 6,
                                paddingVertical: 1,
                            }}
                        >
                            <Text size="xs" style={{ color: CHIP_ACCENT, letterSpacing: 0.3 }}>
                                {t(scopeChip.key, { defaultValue: scopeChip.default })}
                            </Text>
                        </View>
                    </VStack>
                ) : (
                    <Text size="md" className="text-white flex-1 mr-2 capitalize" numberOfLines={2}>
                        {pref.publicationName}
                    </Text>
                )}
                <Pressable
                    testID={`${idBase}-clear`}
                    onPress={() => onClear(pref)}
                    disabled={busy}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('publicationPrefs.clearA11y', { defaultValue: 'Clear preference' })}
                    className="flex-row items-center border border-gray-700 rounded-full px-2.5 py-1"
                >
                    <MaterialIcons name="close" size={13} color="#9ca3af" />
                    <Text size="xs" className="text-gray-400 ml-1">
                        {t('publicationPrefs.clear', { defaultValue: 'Clear' })}
                    </Text>
                </Pressable>
            </HStack>
            <HStack space="sm">
                {KIND_ORDER.map(kind => {
                    const meta = PREF_KIND_META[kind];
                    const active = currentKind === kind;
                    return (
                        <Pressable
                            key={kind}
                            testID={`${idBase}-${kind}`}
                            onPress={() => onSetKind(pref, kind)}
                            disabled={busy}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            className={`flex-1 flex-row items-center justify-center rounded-lg py-2 border ${
                                active ? 'border-transparent' : 'border-gray-700'
                            }`}
                            style={active ? { backgroundColor: `${meta.color}26`, borderColor: meta.color } : undefined}
                        >
                            <MaterialIcons name={meta.icon} size={15} color={active ? meta.color : '#6b7280'} />
                            <Text
                                size="xs"
                                className="ml-1.5"
                                style={{ color: active ? meta.color : '#9ca3af' }}
                            >
                                {t(meta.labelKey, { defaultValue: meta.labelDefault })}
                            </Text>
                        </Pressable>
                    );
                })}
            </HStack>
        </VStack>
    );
};

export default PublicationPrefRow;
