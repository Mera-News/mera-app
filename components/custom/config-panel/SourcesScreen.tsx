import { Box } from '@/components/ui/box';
import React from 'react';
import { useTranslation } from 'react-i18next';
import DrillDownHeader from './DrillDownHeader';
import SourcesTabContent from './SourcesTabContent';

interface SourcesScreenProps {
    readonly onBack: () => void;
}

/**
 * Full-screen host for Sources management (Wave 5 interim access point), pushed
 * from the "Sources" row at the top of the Settings tab now that config-panel's
 * pill tabs are unwired. Mirrors the DrillDownHeader + content composition used
 * by the other pushed drill-down screens (e.g. VisitedPublicationsList).
 * Sources moves into the Explore tab in a later wave.
 */
const SourcesScreen: React.FC<SourcesScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader title={t('settings.sources')} onBack={onBack} />
            <SourcesTabContent />
        </Box>
    );
};

export default SourcesScreen;
