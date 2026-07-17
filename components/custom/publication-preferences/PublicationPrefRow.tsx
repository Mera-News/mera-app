import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import { weightToPrefKind, type PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

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

interface PublicationPrefRowProps {
    readonly pref: PublicationPreferenceModel;
    readonly busy: boolean;
    readonly onSetKind: (publicationName: string, kind: PublicationPrefKind) => void;
    readonly onClear: (publicationName: string) => void;
}

/**
 * One publication preference row: the publication name, a 3-way kind selector
 * (boost / downrank / mute — the active chip doubles as the current-kind badge),
 * and a clear affordance that retires the preference. All mutations are routed
 * by the parent screen through the persona-action executor (change-logged).
 */
const PublicationPrefRow: React.FC<PublicationPrefRowProps> = ({ pref, busy, onSetKind, onClear }) => {
    const { t } = useTranslation();
    const currentKind = weightToPrefKind(pref.weight);

    return (
        <VStack className="px-4 py-3 border-b border-gray-800" space="sm">
            <HStack className="items-center justify-between">
                <Text size="md" className="text-white flex-1 mr-2 capitalize" numberOfLines={2}>
                    {pref.publicationName}
                </Text>
                <Pressable
                    onPress={() => onClear(pref.publicationName)}
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
                            onPress={() => onSetKind(pref.publicationName, kind)}
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
