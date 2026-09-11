// QuickFactCheckCard — the answer to the claim the user tapped, in the thread.
//
// WHAT IT IS NOT: a fact check. It is a summary of what a web search returned
// just now, and the card says so. The Dashboard's list is the other thing — a
// server check that can name the organisations who ruled on a claim — and the
// copy here has to keep the two apart, because a reader who confuses them takes
// "nothing contradicted this" for "a fact-checker cleared it".
//
// THE ONE RULE THIS COMPONENT ENFORCES. Every user-visible line comes from
// `quickFactCheckCopyKey(answer)`, a single mapping over a closed outcome union.
// "we could not search" and "we searched and found nothing" are DIFFERENT
// outcomes with DIFFERENT keys, and there is no code path that renders one for
// the other. That is deliberate: a model narrating this result would be free to
// blur exactly those two, and no test of the underlying data would catch it.

import { Text } from '@/components/ui/text';
import { describeVerdict } from '@/lib/fact-check/fact-check-state';
import { quickFactCheckCopyKey } from '@/lib/chat-tools/quick-fact-check-handler';
import type { QuickFactCheckEntry } from '@/lib/stores/floating-chat-store';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';


// ── Locale keys that land with agent A1's `en.json` splice ────────────────────
// The `t` overloads are GENERATED from en.json, so a key added by another agent
// of this wave is not yet in the union. Cast through one alias rather than
// reaching for `defaultValue`: an inline English default is how English text has
// previously shipped into 19 locale files unnoticed, whereas a missing key is
// loud. The exact keys are in this unit's locale fragment.
type PendingLocaleKey = 'factCheck.disclaimer';
const k = (key: string) => key as PendingLocaleKey;

const ACCENT = 'rgb(231, 138, 83)';
/** Sources shown inline. The rest are in the summary's citation numbers. */
const MAX_SOURCES = 5;

export interface QuickFactCheckCardProps {
  entry: QuickFactCheckEntry;
}

/** Host of a URL, for a compact source line. Falls back to the raw string. */
export function sourceLabel(uri: string): string {
  const match = /^https?:\/\/([^/?#]+)/i.exec(uri ?? '');
  return match ? match[1].replace(/^www\./i, '') : (uri ?? '');
}

const QuickFactCheckCard: React.FC<QuickFactCheckCardProps> = ({ entry }) => {
  const { t } = useTranslation();

  // --- The whole-article (server) pill -------------------------------------
  // No verdict ever renders here: this card only reports that the request was
  // accepted. The answer itself belongs to the Dashboard, which is the point of
  // the slow path.
  if (entry.mode === 'article') {
    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <MaterialIcons name="cloud-upload" size={16} color={ACCENT} />
          <Text size="xs" bold style={styles.title}>
            {entry.label}
          </Text>
        </View>
        <Text size="sm" style={styles.body}>
          {entry.status === 'running'
            ? t(k('factCheck.quickArticleSending'))
            : entry.articleRequested
              ? t(k('factCheck.quickArticleRequested'))
              : t(k('factCheck.quickArticleFailed'))}
        </Text>
      </View>
    );
  }

  // --- The quick (chat) pill ------------------------------------------------
  if (entry.status === 'running' || !entry.answer) {
    return (
      <View style={styles.card}>
        <View style={styles.headerRow}>
          <MaterialIcons name="travel-explore" size={16} color={ACCENT} />
          <Text size="xs" bold style={styles.title}>
            {entry.label}
          </Text>
        </View>
        <Text size="sm" style={styles.body}>
          {t(k('factCheck.quickRunning'))}
        </Text>
      </View>
    );
  }

  const { answer } = entry;
  // THE single outcome→copy mapping. Never inlined, never branched around.
  const headline = t(k(quickFactCheckCopyKey(answer)));
  // A verdict exists ONLY on `answered` (the handler nulls it everywhere else),
  // so a "couldn't search" card can never wear a verdict chip.
  const verdict = answer.verdict ? describeVerdict(answer.verdict) : null;
  const citations = answer.citations.slice(0, MAX_SOURCES);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <MaterialIcons name="travel-explore" size={16} color={ACCENT} />
        <Text size="xs" bold style={styles.title}>
          {entry.label}
        </Text>
      </View>

      {/* The verdict LABEL alone overclaims — "Consistent with sources" reads
          as a clearance. Its `detailKey` is where the hedge lives ("That isn't
          proof it's true — only that nothing contradicting it was found"), so
          the two always render together. */}
      {verdict && (
        <>
          <Text size="sm" bold style={styles.verdict}>
            {t(k(verdict.labelKey))}
          </Text>
          <Text size="xs" style={styles.verdictDetail}>
            {t(k(verdict.detailKey))}
          </Text>
        </>
      )}

      <Text size="sm" style={styles.body}>
        {headline}
      </Text>

      {/* The model's own prose, shown only when there was evidence behind it. */}
      {answer.outcome === 'answered' && !!answer.summary && (
        <Text size="sm" style={styles.body}>
          {answer.summary}
        </Text>
      )}

      {citations.length > 0 && (
        <View style={styles.sources}>
          <Text size="xs" bold style={styles.sourcesHeading}>
            {t('factCheck.citationsHeading')}
          </Text>
          {citations.map((c, i) => (
            <Pressable
              key={`${c.uri}-${i}`}
              onPress={() => void openInAppBrowser(c.uri)}
              accessibilityRole="link"
              accessibilityLabel={t('factCheck.citationA11y', { source: sourceLabel(c.uri) })}
            >
              <Text size="xs" style={styles.sourceLine} numberOfLines={2}>
                {`${i + 1}. ${c.title?.trim() || sourceLabel(c.uri)}`}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* ALWAYS, on every outcome. The one line that stops this card being read
          as the Dashboard's server check. */}
      <Text size="xs" style={styles.disclaimer}>
        {t(k('factCheck.quickDisclaimer'))}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(231, 138, 83, 0.06)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(231, 138, 83, 0.55)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: ACCENT,
    flex: 1,
  },
  verdict: {
    color: 'rgb(232, 232, 232)',
  },
  verdictDetail: {
    color: 'rgb(178, 178, 178)',
  },
  body: {
    color: 'rgb(210, 210, 210)',
  },
  sources: {
    gap: 4,
    marginTop: 2,
  },
  sourcesHeading: {
    color: 'rgb(190, 190, 190)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sourceLine: {
    color: 'rgb(150, 190, 235)',
    textDecorationLine: 'underline',
  },
  disclaimer: {
    color: 'rgb(150, 150, 150)',
    fontStyle: 'italic',
  },
});

export default QuickFactCheckCard;
