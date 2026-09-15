import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { LocationRole } from '@/lib/database/models/Location';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { LOCATION_ROLES } from './location-display';

const ACCENT = '#EDA77E';

interface Props {
  readonly value: LocationRole;
  readonly onChange: (role: LocationRole) => void;
}

/** Icon+label single-select over the 5 locked persona roles. */
const LocationRolePicker: React.FC<Props> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <HStack className="flex-wrap" space="sm">
      {LOCATION_ROLES.map((meta) => {
        const selected = meta.role === value;
        return (
          <Pressable
            key={meta.role}
            onPress={() => onChange(meta.role)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={t(`locations.roles.${meta.labelKey}` as never)}
            className={`flex-row items-center rounded-full border px-3 py-2 mb-2 ${
              selected ? 'border-primary-500 bg-primary-500/10' : 'border-gray-700'
            }`}
          >
            <MaterialIcons name={meta.icon} size={16} color={selected ? ACCENT : '#999999'} />
            <Text
              className={`ml-2 text-sm ${selected ? 'text-white' : 'text-gray-300'}`}
            >
              {t(`locations.roles.${meta.labelKey}` as never)}
            </Text>
          </Pressable>
        );
      })}
    </HStack>
  );
};

export default LocationRolePicker;
