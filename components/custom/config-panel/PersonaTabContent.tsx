// DEPRECATED(wave-12): replaced by the Profile hub; delete in wave-13 cleanup.
// No longer mounted in the live tree — ProfileTabScreen renders ProfileHubScreen.
import React from 'react';
import { Box } from '@/components/ui/box';
import PersonaL1MeraProtocol from './PersonaL1MeraProtocol';

interface PersonaTabContentProps {
    readonly userId: string;
}

const PersonaTabContent: React.FC<PersonaTabContentProps> = ({ userId }) => {
    return (
        <Box className="flex-1">
            <PersonaL1MeraProtocol userId={userId} />
        </Box>
    );
};

export default PersonaTabContent;
