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
