// Stands in for @expo/vector-icons in the browser export: the same Material
// glyph set, drawn from the Material Icons web font by ligature name.
import React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

export const MaterialIcons: React.FC<{ name: string; size: number; color?: string; style?: StyleProp<TextStyle> }> = ({ name, size, color, style }) => (
    <Text style={[{ fontFamily: 'Material Icons', fontSize: size, lineHeight: size, width: size, height: size, color }, style]}>
        {name.replace(/-/g, '_')}
    </Text>
);
