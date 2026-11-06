// Saved's Archive list, pushed in the Library stack from the Read later row.

import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import SavedSuggestionsScreen from './SavedSuggestionsScreen';

const ArchiveScreen: React.FC<{ readonly onBack: () => void }> = ({ onBack }) => {
    const { t } = useTranslation();
    const listEnd = useListEndClearance();
    return (
        <View style={{ flex: 1 }}>
            <DrillDownHeader title={t('library.saved.archive')} onBack={onBack} backTestID="saved-archive-back" />
            <View style={{ flex: 1 }}>
                <SavedSuggestionsScreen list="archive" listEndPadding={listEnd} />
            </View>
        </View>
    );
};

export default ArchiveScreen;
