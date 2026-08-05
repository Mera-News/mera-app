import { ChevronDownIcon } from '@/components/ui/icon';
import {
    Select,
    SelectBackdrop,
    SelectContent,
    SelectDragIndicator,
    SelectDragIndicatorWrapper,
    SelectIcon,
    SelectInput,
    SelectItem,
    SelectPortal,
    SelectTrigger,
} from '@/components/ui/select';
import {
    IMPORTANCE_THRESHOLDS,
    type ImportanceThreshold,
} from '@/lib/feed-ordering/importance-filter';
import React from 'react';
import { useTranslation } from 'react-i18next';

// Same label keys as RelevanceChip, for the same reason: the control and the
// worded chip on each card must never disagree.
const LABEL_KEYS: Record<ImportanceThreshold, string> = {
    high: 'relevance.high',
    medium: 'relevance.medium',
    low: 'relevance.low',
};

interface ImportanceFilterDropdownProps {
    readonly value: ImportanceThreshold;
    readonly onChange: (threshold: ImportanceThreshold) => void;
    /** e.g. 'feed-importance' → trigger `feed-importance-trigger`, options
     *  `feed-importance-{high|medium|low}`. */
    readonly testIDPrefix: string;
}

/**
 * The importance-threshold control as a compact dropdown: a rounded gluestack
 * Select whose trigger chip shows the current minimum band (`Med ⌄`) and opens
 * the standard select actionsheet. Fits INSIDE a screen-title row, which the
 * three-pill variant (ImportanceFilterPills) cannot in the longer languages.
 */
const ImportanceFilterDropdown: React.FC<ImportanceFilterDropdownProps> = ({
    value,
    onChange,
    testIDPrefix,
}) => {
    const { t } = useTranslation();

    return (
        <Select
            // Remount on external value/locale changes: the Select tracks its
            // displayed label in internal state that only item presses update,
            // so `initialLabel` alone would go stale.
            key={`${value}-${t(LABEL_KEYS[value] as any)}`}
            selectedValue={value}
            initialLabel={t(LABEL_KEYS[value] as any)}
            onValueChange={(v) => onChange(v as ImportanceThreshold)}
            accessibilityLabel={t('importanceFilter.a11yLabel')}
        >
            <SelectTrigger
                variant="rounded"
                size="md"
                className="border-primary-500"
                testID={`${testIDPrefix}-trigger`}
            >
                <SelectInput className="text-primary-500 font-semibold" />
                <SelectIcon className="mr-3 text-primary-400" as={ChevronDownIcon} />
            </SelectTrigger>
            <SelectPortal>
                <SelectBackdrop />
                <SelectContent>
                    <SelectDragIndicatorWrapper>
                        <SelectDragIndicator />
                    </SelectDragIndicatorWrapper>
                    {IMPORTANCE_THRESHOLDS.map((threshold) => (
                        <SelectItem
                            key={threshold}
                            value={threshold}
                            label={t(LABEL_KEYS[threshold] as any)}
                            testID={`${testIDPrefix}-${threshold}`}
                        />
                    ))}
                </SelectContent>
            </SelectPortal>
        </Select>
    );
};

export default ImportanceFilterDropdown;
