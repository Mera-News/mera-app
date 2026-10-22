// When Mera Protocol is opened with `?focus=on-device`, where to scroll and what to
// give screen-reader focus. Pure, so it carries a test; the screen feeds it two
// layout events and acts on the answer once.
//
// Both inputs come from onLayout, never from measureLayout on a ref: the kit
// Pressable's ref is not a native component, so measuring it fails.

export interface ProtocolFocusInput {
  focus: string | undefined;
  /** Already focused during this mount. */
  done: boolean;
  /** y of the "How Mera runs" section within the ScrollView content. */
  sectionY: number | null;
  /** Native tag of the section's heading, from its own layout event. */
  rowTag: number | null;
}

export const PROTOCOL_FOCUS_TOP_GAP = 16;

/** Null until both layouts are known, after the first focus, or without the param. */
export function protocolFocusPlan(i: ProtocolFocusInput): { scrollY: number; tag: number } | null {
  if (i.focus !== 'on-device' || i.done || i.sectionY == null || i.rowTag == null) return null;
  return { scrollY: Math.max(0, i.sectionY - PROTOCOL_FOCUS_TOP_GAP), tag: i.rowTag };
}
