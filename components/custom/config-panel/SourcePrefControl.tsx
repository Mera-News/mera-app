import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import type { SourcePrefUiLevel } from '@/lib/database/services/publication-pref-ui-actions';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const PRIORITISE_COLOR = '#10b981';
const DEPRIORITISE_COLOR = '#f59e0b';
const INACTIVE_COLOR = '#6b7280';

interface SourcePrefControlProps {
    /** The preference level currently in effect for this row. */
    readonly current: SourcePrefUiLevel;
    /** Disables both buttons (in-flight write, or free-tier read-only). */
    readonly busy?: boolean;
    /**
     * Called with the NEXT level a tap resolves to — this component owns the
     * toggle-off rule (tapping the already-active control clears it back to
     * `'none'`; tapping the other one switches directly), so every caller
     * (L1 country rows, L2 publisher rows) gets identical behavior for free.
     */
    readonly onChange: (next: SourcePrefUiLevel) => void;
    /** Stable testID root (harness/QA) — buttons render `${testIDPrefix}-up` / `-down`. */
    readonly testIDPrefix: string;
}

/**
 * Shared ↑ (prioritise) / ↓ (deprioritise) control — item 9's L1/L2
 * vocabulary. Deliberately no third "mute"/block affordance here: hard
 * exclusion stays exclusive to the dedicated `publication-preferences`
 * screen's 3-way selector (see that screen's header comment). Callers are
 * responsible for turning `onChange`'s level into an actual write via
 * `setSourcePrefFromUi` — this component only renders state and intent.
 */
const SourcePrefControl: React.FC<SourcePrefControlProps> = ({ current, busy = false, onChange, testIDPrefix }) => {
    const { t } = useTranslation();
    const isPrioritised = current === 'prioritised';
    const isDeprioritised = current === 'deprioritised';

    const handlePressUp = useCallback(() => {
        onChange(isPrioritised ? 'none' : 'prioritised');
    }, [isPrioritised, onChange]);

    const handlePressDown = useCallback(() => {
        onChange(isDeprioritised ? 'none' : 'deprioritised');
    }, [isDeprioritised, onChange]);

    return (
        <HStack space="xs" className="items-center">
            <Pressable
                testID={`${testIDPrefix}-up`}
                onPress={handlePressUp}
                disabled={busy}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ selected: isPrioritised, disabled: busy }}
                accessibilityLabel={t('sourcePrefControl.prioritiseA11y', { defaultValue: 'Prioritise this source' })}
                className={`w-8 h-8 items-center justify-center rounded-full border ${
                    isPrioritised ? 'border-transparent' : 'border-gray-700'
                }`}
                style={isPrioritised ? { backgroundColor: `${PRIORITISE_COLOR}26` } : undefined}
            >
                <MaterialIcons
                    name="arrow-upward"
                    size={16}
                    color={isPrioritised ? PRIORITISE_COLOR : INACTIVE_COLOR}
                />
            </Pressable>
            <Pressable
                testID={`${testIDPrefix}-down`}
                onPress={handlePressDown}
                disabled={busy}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ selected: isDeprioritised, disabled: busy }}
                accessibilityLabel={t('sourcePrefControl.deprioritiseA11y', { defaultValue: 'Deprioritise this source' })}
                className={`w-8 h-8 items-center justify-center rounded-full border ${
                    isDeprioritised ? 'border-transparent' : 'border-gray-700'
                }`}
                style={isDeprioritised ? { backgroundColor: `${DEPRIORITISE_COLOR}26` } : undefined}
            >
                <MaterialIcons
                    name="arrow-downward"
                    size={16}
                    color={isDeprioritised ? DEPRIORITISE_COLOR : INACTIVE_COLOR}
                />
            </Pressable>
        </HStack>
    );
};

export default SourcePrefControl;
