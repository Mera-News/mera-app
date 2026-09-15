import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

interface PinKeypadProps {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  disabled?: boolean;
  // When toggled true, the dot row plays a shake animation (wrong-PIN feedback).
  error?: boolean;
}

const KEYS: (string | 'backspace' | null)[] = [
  '1', '2', '3',
  '4', '5', '6',
  '7', '8', '9',
  null, '0', 'backspace',
];

/**
 * Self-contained numeric PIN entry: a row of dot indicators + a fixed 3x4
 * keypad. Avoids the soft-keyboard entirely (focus/dismiss races on a lock
 * screen) and keeps the layout stable in dark mode.
 */
const PinKeypad: React.FC<PinKeypadProps> = ({
  value,
  onChange,
  length = 4,
  disabled = false,
  error = false,
}) => {
  const shakeX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!error) return;
    Animated.sequence([
      Animated.timing(shakeX, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: -8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeX, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [error, shakeX]);

  const press = (key: string | 'backspace' | null) => {
    if (disabled || key === null) return;
    if (key === 'backspace') {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length >= length) return;
    onChange(value + key);
  };

  return (
    <Box className="items-center">
      {/* Dot indicators */}
      <Animated.View style={{ transform: [{ translateX: shakeX }] }}>
        <HStack space="lg" className="justify-center mb-10">
          {Array.from({ length }).map((_, i) => {
            const filled = i < value.length;
            const dotColor = error
              ? 'bg-error-500 border-error-500'
              : filled
                ? 'bg-primary-500 border-primary-500'
                : 'bg-transparent border-gray-600';
            return (
              <Box key={i} className={`w-4 h-4 rounded-full border-2 ${dotColor}`} />
            );
          })}
        </HStack>
      </Animated.View>

      {/* Keypad */}
      <Box className="w-full max-w-[300px]">
        {[0, 1, 2, 3].map((row) => (
          <HStack key={row} className="justify-between mb-4" space="lg">
            {KEYS.slice(row * 3, row * 3 + 3).map((key, col) => {
              if (key === null) {
                return <Box key={col} className="w-20 h-20" />;
              }
              return (
                <Pressable
                  key={col}
                  onPress={() => press(key)}
                  disabled={disabled}
                  className={`w-20 h-20 rounded-full items-center justify-center border border-gray-700 ${disabled ? 'opacity-40' : 'active:bg-gray-800'
                    }`}
                >
                  {key === 'backspace' ? (
                    <MaterialIcons name="backspace" size={24} color="#ffffff" />
                  ) : (
                    <Text className="text-white text-2xl font-semibold">{key}</Text>
                  )}
                </Pressable>
              );
            })}
          </HStack>
        ))}
      </Box>
    </Box>
  );
};

export default PinKeypad;
