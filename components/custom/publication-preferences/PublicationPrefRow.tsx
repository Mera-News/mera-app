import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import type { SourceScopeKind } from '@/lib/database/models/PublicationPreference';
import { weightToPrefKind, type PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { MaterialIcons } from '@expo/vector-icons';
import { tint, useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import SourceKindChip from './SourceKindChip';

/** A country scope can never be muted, so its choices are More and Fewer. */
const KIND_ORDER = ['boost', 'deprioritize'] as const;
const CHOICE_LABEL = {
    boost: 'you.sources.more',
    deprioritize: 'you.sources.fewer',
} as const;

/**
 * source-pref P4. A SCOPE row (`scopeKind != null`) stores its human label
 * ("India") in `publication_name`, so undecorated it reads exactly like a
 * publication named "India". This chip is the only thing that tells them apart.
 */
const SCOPE_KIND_CHIPS: Record<SourceScopeKind, { key: string; default: string }> = {
    country: { key: 'publicationPrefs.scopeKindCountry', default: 'Country' },
};

/** Stable, kebab-cased testID segment (harness/QA). */
function normalizeForTestId(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** More / Fewer (+ Clear when something is set). */
const SourceKindChoices: React.FC<{
    readonly idBase: string;
    readonly current: PublicationPrefKind | null;
    readonly busy: boolean;
    readonly onPick: (kind: PublicationPrefKind) => void;
    readonly onClear?: () => void;
}> = ({ idBase, current, busy, onPick, onClear }) => {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <HStack space="sm" className="items-center">
            {KIND_ORDER.map((kind) => {
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
 * One country scope on the Sources screen ("prefer sources from India"): the
 * label, a Country chip and a More / Fewer chip. A scope has no publication
 * page, so tapping opens the choices under it; the screen keeps one row open
 * at a time. Publications are PublicationListRow rows that open their page.
 */
const PublicationPrefRow: React.FC<PublicationPrefRowProps> = ({ pref, busy, isOpen, onToggle, onSetKind, onClear }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const currentKind = weightToPrefKind(pref.weight);
    // Keyed by scopeValue (stable, ISO alpha-3), not the label, which can
    // collide with a real publication name.
    const idBase = `pub-pref-scope-${pref.scopeKind ?? 'country'}-${normalizeForTestId(pref.scopeValue ?? pref.publicationName)}`;
    const scopeChip = SCOPE_KIND_CHIPS[pref.scopeKind ?? 'country'];

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
                        {pref.publicationName}
                    </Text>
                    <View
                        testID={`${idBase}-kind-chip`}
                        style={{ alignSelf: 'flex-start', borderRadius: 6, borderWidth: 1, borderColor: tint(colors.accent, 0.5), paddingHorizontal: 6, paddingVertical: 1 }}
                    >
                        <Text size="xs" style={{ color: colors.accent, letterSpacing: 0.3 }}>
                            {t(scopeChip.key, { defaultValue: scopeChip.default })}
                        </Text>
                    </View>
                </VStack>
                {currentKind ? <SourceKindChip kind={currentKind} testID={`${idBase}-chip`} /> : null}
                {/* Expands in place, so a down chevron, never a forward one. */}
                <MaterialIcons name={isOpen ? 'expand-less' : 'expand-more'} size={20} color={colors.ink2} style={{ marginLeft: 6 }} />
            </Pressable>
            {isOpen ? (
                <VStack space="sm" className="pb-3">
                    <SourceKindChoices
                        idBase={idBase}
                        current={currentKind}
                        busy={busy}
                        onPick={(kind) => onSetKind(pref, kind)}
                        onClear={() => onClear(pref)}
                    />
                </VStack>
            ) : null}
        </VStack>
    );
};

export default PublicationPrefRow;
