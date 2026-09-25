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
    // testID defaults to `icon-<name>`, so this drops in for the View mocks
    // that suites use to pin a glyph by name.
    const MaterialIcons = (p: any) =>
        h(Text, { testID: `icon-${p.name}`, ...p, children: String.fromCodePoint(glyphs[p.name] ?? 0xe000) });
    MaterialIcons.glyphMap = glyphs;
    return { MaterialIcons };
}

function textOf(node: any): string {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    // NOTE: a subtree marked `accessibilityElementsHidden` STILL contributes
    // its text on iOS (proven on device, batch 21), so it is not skipped here.
    // The only fix is an explicit label on the container.
    // iOS composes a container's label from its subviews, taking a subview's
    // OWN accessibilityLabel instead of descending into it (RN's
    // RCTRecursiveAccessibilityLabel), so an explicitly labelled child
    // contributes that label, never its glyph. That is the LABEL only: the
    // glyph can still surface as its own StaticText under a labelled
    // container, which exposedGlyphTexts below checks.
    if (typeof node.type === 'string' && typeof node.props?.accessibilityLabel === 'string') {
        return node.props.accessibilityLabel;
    }
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

/** Icon glyphs VoiceOver can land on as their own StaticText (captured on
 *  device, ux2 batch 26). On iOS the hidden props do NOT hide a glyph that has
 *  ANY accessible ancestor, labelled or not, so a glyph passes only when it
 *  carries `accessible={false}`, `accessibilityElementsHidden` and
 *  `importantForAccessibility="no-hide-descendants"` itself AND no host
 *  ancestor is `accessible`. A labelled button with an icon is therefore a
 *  childless Pressable laid over a hidden visual, never a wrapper.
 *  THROWS when the tree drew no glyph at all: an empty scan always passes. */
export function exposedGlyphTexts(root: any): string[] {
    const exposed: string[] = [];
    const glyphTexts = root.findAll(
        (n: any) => n.type === 'Text' && PRIVATE_USE.test(textOf(n)),
    );
    // A scan of a tree that drew no glyph cannot fail, so it is not a check:
    // the icon mock is missing, or the state under test renders no icon.
    if (glyphTexts.length === 0) {
        throw new Error(
            'exposedGlyphTexts: no private-use glyph rendered. Mock @expo/vector-icons with glyphIconModule() and render a state that draws an icon.',
        );
    }
    for (const t of glyphTexts) {
        const hidden = t.props?.accessible === false
            && t.props?.accessibilityElementsHidden === true
            && t.props?.importantForAccessibility === 'no-hide-descendants';
        let underAccessible = false;
        for (let p = t.parent; p; p = p.parent) {
            if (typeof p.type === 'string' && p.props?.accessible === true) underAccessible = true;
        }
        if (!hidden || underAccessible) {
            const why = !hidden ? 'not hidden' : 'under an accessible element';
            exposed.push(`${t.props?.testID ?? '(no testID)'} (${why}): ${JSON.stringify(textOf(t))}`);
        }
    }
    return exposed;
}
