import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { useIsStarredPublication } from '@/components/custom/cards/starred-publications';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';

/** A star before a publication the reader tagged More from or Subscribed. `name` is the RAW name. */
const PublicationStar: React.FC<{ readonly name: string | null | undefined; readonly size?: number }> = ({
    name,
    size = 12,
}) => {
    const colors = useColors();
    if (!useIsStarredPublication(name)) return null;
    return (
        <MaterialIcons
            name="star"
            size={size}
            color={colors.accent}
            testID="publication-star"
            {...DECORATIVE_ICON_A11Y}
        />
    );
};

export default PublicationStar;
