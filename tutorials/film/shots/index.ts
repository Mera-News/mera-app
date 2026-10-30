// The real For You screen per app language, from the newest store captures (iCloud Drive/Mera/Store Screenshots/<version>/captures/<locale>/feed.png,
// shrunk to 760px). The film's last scene drops its notes into it. Refresh them with each store capture set; keys are the APP language codes.
export const FEED_SHOTS: Readonly<Record<string, number | string>> = {
    'en': require('./feed-en.jpg'),
    'ar': require('./feed-ar.jpg'),
    'de': require('./feed-de.jpg'),
    'es': require('./feed-es.jpg'),
    'fr': require('./feed-fr.jpg'),
    'hi': require('./feed-hi.jpg'),
    'id': require('./feed-id.jpg'),
    'it': require('./feed-it.jpg'),
    'ja': require('./feed-ja.jpg'),
    'ko': require('./feed-ko.jpg'),
    'nl': require('./feed-nl.jpg'),
    'pl': require('./feed-pl.jpg'),
    'pt': require('./feed-pt.jpg'),
    'ru': require('./feed-ru.jpg'),
    'th': require('./feed-th.jpg'),
    'tr': require('./feed-tr.jpg'),
    'uk': require('./feed-uk.jpg'),
    'vi': require('./feed-vi.jpg'),
    'zh-Hans': require('./feed-zh-Hans.jpg'),
    'zh-Hant': require('./feed-zh-Hant.jpg'),
};

export const feedShotFor = (language: string): number | string => FEED_SHOTS[language] ?? FEED_SHOTS.en;
