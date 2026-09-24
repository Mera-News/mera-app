/* eslint-disable @typescript-eslint/no-require-imports */
// Icon-font glyphs in accessibility labels.
//
// On device an `@expo/vector-icons` icon IS a Text whose content is a
// private-use character (U+E000–U+F8FF). A pressable with no explicit
// `accessibilityLabel` is read by VoiceOver as the concatenation of its
// descendants' text, glyph included: the detail screen's Read button read
// "<glyph>, Read on Google Translate". jest renders no glyph at all, so the
// leak is invisible there unless the mock draws one, which this does.
//
//   jest.mock('@expo/vector-icons', () =>
//       require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
//   expect(privateUseLabelLeaks(UNSAFE_root)).toEqual([]);

const PRIVATE_USE = /[-]/;

export function glyphIconModule() {
    // Bracket access on purpose: the NativeWind babel transform rewrites a
    // literal `React.createElement(...)` into css-interop's element factory,
    // which suites that stub css-interop do not have.
    const h = require('react')['createElement'];
    const { Text } = require('react-native');
    const glyphs = require('@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialIcons.json');
    const MaterialIcons = (p: any) =>
        h(Text, { ...p, children: String.fromCodePoint(glyphs[p.name] ?? 0xe000) });
    MaterialIcons.glyphMap = glyphs;
    return { MaterialIcons };
}

function textOf(node: any): string {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    const kids = node.children ?? [];
    return kids.map((k: any) => textOf(k)).join('');
}

/** The label VoiceOver reads for each accessible element: its explicit
 *  `accessibilityLabel`, else its descendants' text. Returns the ones that
 *  carry an icon-font glyph. */
export function privateUseLabelLeaks(root: any): string[] {
    const leaks: string[] = [];
    const accessible = root.findAll(
        (n: any) => typeof n.type === 'string' && n.props?.accessible === true,
    );
    for (const n of accessible) {
        const label = typeof n.props.accessibilityLabel === 'string' ? n.props.accessibilityLabel : textOf(n);
        if (PRIVATE_USE.test(label)) leaks.push(`${n.props.testID ?? '(no testID)'}: ${JSON.stringify(label)}`);
    }
    return leaks;
}
