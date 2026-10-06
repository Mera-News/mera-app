import { Box } from '@/components/ui/box';
import { Input, InputField } from '@/components/ui/input';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { View } from 'react-native';

// The search glyph is drawn in a plain hidden View over the Input from its
// parent, never inside it: in an InputSlot (a Pressable) a glyph surfaced as
// its own StaticText, and even hidden inside the Input root it was still
// composed into the containers' labels (both captured).
const GLYPH = 18;
/** pl-3 at NativeWind's 14pt rem: the slot's old padding. */
const SLOT_PAD = 10.5;
/** The outline variant's 1pt border. */
const INPUT_BORDER = 1;
const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;
/** The md Input's h-10 at NativeWind's 14pt rem. */
const INPUT_HEIGHT = 35;
/** The glyph where its slot used to draw it: border + pad in from the
 *  Input's left edge, centred in the Input's height. */
const SEARCH_GLYPH_STYLE = {
    position: 'absolute',
    top: 0,
    height: INPUT_HEIGHT,
    left: INPUT_BORDER + SLOT_PAD,
    justifyContent: 'center',
} as const;

interface ExploreSearchBarProps {
    readonly query: string;
    readonly onChangeQuery: (next: string) => void;
    /** Field placeholder and accessibility label. */
    readonly placeholder: string;
}

/**
 * The full-screen Search route's field (`components/custom/world/SearchScreen`).
 * It mounts only as the result of a tap on the World header's search icon, so
 * it `autoFocus`es: the keyboard comes up without a second tap. There is no ✕
 * of ours: Cancel sits beside the bar, and the native clear button empties it.
 *
 * Purely presentational: all query state, debouncing and fetching live in
 * `lib/news-search/use-news-search.ts`.
 *
 * testID lives on the wrapping Box, not the Input/InputField — gluestack's
 * InputField is an accessibility container and swallows a testID prop placed
 * directly on it (see AddPhraseModal for the same workaround).
 */
const ExploreSearchBar: React.FC<ExploreSearchBarProps> = ({ query, onChangeQuery, placeholder }) => (
    <Box testID="explore-search-input" className="flex-1">
        <Input variant="outline" size="md" className="border-gray-700" testID="explore-search-field">
            {/* A spacer holds the glyph's old width; the glyph itself is drawn
                over the Input below, from OUTSIDE it: inside, the bar's
                containers read "<glyph>, Search all news" on device even with
                every hidden prop set. */}
            <View style={{ width: SLOT_PAD + GLYPH }} />
            <InputField
                // The placeholder is the field's name; gluestack's default
                // label was the literal "Input Field".
                aria-label={placeholder}
                placeholder={placeholder}
                placeholderTextColor="#666666"
                value={query}
                onChangeText={onChangeQuery}
                className="text-white"
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                autoFocus
                // Our only clear control (iOS; Android keyboards carry their own).
                clearButtonMode="while-editing"
            />
        </Input>
        <View pointerEvents="none" {...HIDDEN} style={SEARCH_GLYPH_STYLE}>
            <MaterialIcons name="search" size={GLYPH} color="#999999" {...HIDDEN} />
        </View>
    </Box>
);

export default ExploreSearchBar;
