// Props that hide a purely DECORATIVE icon from accessibility.
//
// A decorative icon adds nothing a screen-reader user needs, so it is not an
// element of its own and is hidden from TalkBack's traversal
// (`importantForAccessibility`). It does NOT keep the icon's glyph out of an
// iOS container's COMPOSED label: RN builds that from every descendant Text,
// hidden or not (proven on device, batch 21). A container that holds icons
// needs an explicit accessibilityLabel (see the card roots). Never use this on
// an icon that carries meaning on its own (a button's only content).
export const DECORATIVE_ICON_A11Y = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;
