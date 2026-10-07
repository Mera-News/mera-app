import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

const HEIGHT = 44;
const GLYPH = 16;
const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;

interface ExploreSearchBarProps {
    readonly query: string;
    readonly onChangeQuery: (next: string) => void;
    /** Field placeholder and accessibility label. */
    readonly placeholder: string;
    /** Search opens ready to type; Arrange's add field waits for a tap. */
    readonly autoFocus?: boolean;
    readonly autoCapitalize?: 'none' | 'words';
    readonly testID?: string;
}

/**
 * The 44pt pill search field: Search's bar and Arrange's add-a-country field.
 * Orange border while focused, an orange glyph, 16pt text.
 *
 * A plain TextInput, not gluestack's Input: that one is overflow-hidden at
 * 35pt, labels itself "Input Field", and composed a glyph drawn anywhere
 * inside it into the bar's labels on device. The glyph here sits beside the
 * input, hidden, and the input carries the placeholder as its label.
 *
 * Purely presentational: Search's query state, debouncing and fetching live
 * in `lib/news-search/use-news-search.ts`.
 */
const ExploreSearchBar: React.FC<ExploreSearchBarProps> = ({
    query,
    onChangeQuery,
    placeholder,
    autoFocus = false,
    autoCapitalize = 'none',
    testID = 'explore-search-input',
}) => {
    const colors = useColors();
    const keyboard = useThemeMode();
    const [focused, setFocused] = useState(autoFocus);
    return (
        <View
            testID={testID}
            style={[styles.field, { borderColor: focused ? colors.accent : colors.trackBorder, backgroundColor: colors.surfaceRaised }]}
        >
            <View {...HIDDEN}>
                <MaterialIcons name="search" size={GLYPH} color={colors.accent} />
            </View>
            <TextInput
                aria-label={placeholder}
                placeholder={placeholder}
                placeholderTextColor={colors.ink3}
                value={query}
                onChangeText={onChangeQuery}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                style={[styles.input, { color: colors.ink }]}
                autoCorrect={false}
                autoCapitalize={autoCapitalize}
                returnKeyType="search"
                keyboardAppearance={keyboard}
                autoFocus={autoFocus}
                // Our only clear control (iOS; Android keyboards carry their own).
                clearButtonMode="while-editing"
                testID={`${testID}-field`}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    field: {
        flex: 1,
        height: HEIGHT,
        borderRadius: HEIGHT / 2,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 14,
        paddingRight: 6,
    },
    input: { flex: 1, height: HEIGHT, fontSize: 16 },
});

export default ExploreSearchBar;
