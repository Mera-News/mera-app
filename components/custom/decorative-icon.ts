// Props that hide a purely DECORATIVE icon from accessibility.
//
// An icon-font icon is a Text holding a private-use glyph. Inside a container
// with no explicit label (a card root), VoiceOver reads the children's text,
// glyph included ("<glyph> Der Spiegel"). A decorative icon adds nothing a
// screen-reader user needs, so it is hidden: iOS `accessibilityElementsHidden`,
// Android `importantForAccessibility`, and not an element of its own. Never use
// this on an icon that carries meaning on its own (a button's only content).
export const DECORATIVE_ICON_A11Y = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;
