/** The rotating "Choose your language" order: the phone's language first (or
 *  English when the app has no dictionary for it), then the rest as listed. */
export function languageHeadingOrder(phone: string, codes: readonly string[]): string[] {
    const first = codes.includes(phone) ? phone : 'en';
    return [first, ...codes.filter((c) => c !== first)];
}
