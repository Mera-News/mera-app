// CardActionBar — the Instagram-style action row under a story card. Borderless
// icons, no pills, no backgrounds: Mera · thumb-up · thumb-down · bookmark ·
// (optional) track · (optional) share, distributed EVENLY across the row.
//
// THE one action row. Consumers:
//   - ArticleSuggestionCard — the For You feed (FeedScreen) and the fact feed
//     (FactFeedScreen).
//   - ArticleFeedbackPrompt — the article + suggestion DETAIL screens.
//   - ArticleActionsRow — the standalone card (Saved list).
// The latter two used to hand-roll their own row of 48pt round,
// primary-orange-outlined buttons. They were converted to this component
// for card parity. A liked article reads GREEN on the detail screens rather
// than orange for the same reason: all-white cannot distinguish recorded from
// not-recorded.
//
// A recorded verdict is FILLED at once, on every surface (owner: one
// behaviour). There is no hollow "no reason yet" state: the feedback tree the
// tap opens is optional refinement. D15 is a LEARNING rule, not a display
// one: a bare verdict is stored and shown, but stamped processed at write so
// it never reaches the digest (article-feedback-service).
//
// The Mera glyph is DELIBERATELY here as well as on the rationale block
// ("Mera's voice" — see ArticleSuggestionCard). It was briefly removed from this
// row, which left suggestion cards inconsistent with standalone cards
// (ArticleActionsRow always kept its Mera button). View consistency across card
// types won: both entry points call the SAME handler, and this one is the
// canonical affordance carrying `card-action-mera` — the rationale glyph is
// `rationale-mera`.
//
// Icons are larger than the original (ICON_SIZE) and the old "left cluster +
// flex spacer + right cluster" layout is `space-evenly`, so nothing is jammed
// against the card's right edge — where the Feed's scroll-to-top FAB overlaps
// it. `space-evenly` recomputes itself for 4 or 5 buttons, so restoring Mera
// needed no spacing constant to change.

import { Pressable } from '@/components/ui/pressable';
import { HStack } from '@/components/ui/hstack';
import MeraLogo from '@/components/custom/MeraLogo';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { ThumbsUp, ThumbsDown, Bookmark, Crosshair, Share, Share2, SearchCheck, Ellipsis } from 'lucide-react-native';
import { Platform } from 'react-native';
import React from 'react';
import { useTranslation } from 'react-i18next';

const WHITE = '#FFFFFF';
const LIKE = '#22C55E';
const DISLIKE = '#EF4444';
const SAVE_ACCENT = 'rgb(231,138,83)';
/** Disabled ink for a control that has already done its job. */
const MUTED = '#6B7280';
const ICON_SIZE = 27;
const STROKE = 1.8;

interface CardActionBarProps {
  verdict: Verdict | null;
  saved: boolean;
  onLike: () => void;
  onDislike: () => void;
  /** Ask Mera. The SAME handler the rationale block's glyph calls. */
  onAskMera: () => void;
  /** Optional — omitted ⇒ no bookmark at all, same contract as `onShare`.
   *  `ArticleFeedbackPrompt`'s `save` prop is optional and a bookmark that
   *  toggles nothing is worse than no bookmark. */
  onToggleSave?: () => void;
  /** Optional "track story" toggle — a crosshair right of the bookmark. Hidden
   *  entirely when undefined, which is the FEED's case: a feed card has no
   *  track affordance by design (see TrackedStoriesScreen's empty state), the
   *  detail screens and the standalone card do. Added when those two adopted
   *  this row; without it the conversion would have had to DELETE an existing
   *  affordance, which is not a styling change. */
  onTrack?: () => void;
  tracked?: boolean;
  /** Optional share action — renders a Share2 icon right of the bookmark. Hidden
   *  entirely when undefined (e.g. a story with no article URL). */
  onShare?: () => void;
  /** Optional fact-check toggle — a tick right of the track crosshair. Shows and
   *  hides the fact-check SECTION on the article detail screens.
   *
   *  Hidden entirely when undefined, and that is the FEED card's case, by
   *  design: the section this toggles only exists on the detail screens, so a
   *  tick on a feed card would start a search with nowhere to show the answer.
   *  Same optional-prop contract as `onTrack`, for the same reason. */
  onFactCheck?: () => void;
  /** none = never asked · pending = asked, no answer yet · done = resolved.
   *
   *  A tick that looks identical before and after a check is a bad affordance,
   *  so the states are carried by three signals at once, never colour alone
   *  (the same rule the Crosshair follows): a SINGLE tick for asked-or-unasked
   *  vs a DOUBLE tick for answered, colour, and a changed accessibility label.
   *  The single/double idiom is borrowed from messaging apps, where it already
   *  means exactly "sent" vs "delivered". */
  factCheckState?: 'none' | 'pending' | 'done';
  /** Horizontal padding of the row. Defaults to 16 (the card-root look). Hosts
   *  that already inset the row (e.g. ArticleCardBase's `p-4`) pass 0 to avoid
   *  doubling the horizontal padding. */
  horizontalPadding?: number;
  /** D3: opens the shared ••• menu. When set, the row is the four inline
   *  actions (like, not for me, save, share) plus •••, and Ask Mera, Follow and
   *  Check for fact checks live in the menu instead of inline. Absent: the row
   *  renders exactly as before, for any host not yet on the menu. */
  onOverflow?: () => void;
}

const CardActionBar: React.FC<CardActionBarProps> = ({
  verdict,
  saved,
  onLike,
  onDislike,
  onAskMera,
  onToggleSave,
  onTrack,
  tracked = false,
  onShare,
  onFactCheck,
  factCheckState = 'none',
  horizontalPadding = 16,
  onOverflow,
}) => {
  const { t } = useTranslation();
  const iconSize = ICON_SIZE;
  // 10pt of slop around a 27pt glyph: a ~47pt target.
  const hitSlop = 10;
  const liked = verdict === 'like';
  const disliked = verdict === 'dislike';
  // A recorded verdict is coloured AND filled, at once (see the header).
  const likeFill = liked ? LIKE : 'none';
  const dislikeFill = disliked ? DISLIKE : 'none';

  return (
    <HStack
      className="items-center"
      style={{
        paddingHorizontal: horizontalPadding,
        paddingVertical: 12,
        justifyContent: 'space-evenly',
      }}
    >
      {onOverflow ? null : (
        <Pressable
          testID="card-action-mera"
          onPress={onAskMera}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityLabel={t('swipeFeed.askMera')}
        >
          <MeraLogo size={iconSize} animated={false} />
        </Pressable>
      )}

      <Pressable
        testID="card-action-like"
        onPress={onLike}
        hitSlop={hitSlop}
        accessibilityRole="button"
        accessibilityState={{ selected: liked }}
        accessibilityLabel={t('articleFeedback.likeLabel')}
      >
        <ThumbsUp
          size={iconSize}
          strokeWidth={STROKE}
          color={liked ? LIKE : WHITE}
          fill={likeFill}
        />
      </Pressable>

      <Pressable
        testID="card-action-dislike"
        onPress={onDislike}
        hitSlop={hitSlop}
        accessibilityRole="button"
        accessibilityState={{ selected: disliked }}
        accessibilityLabel={t('articleFeedback.dislikeLabel')}
      >
        <ThumbsDown
          size={iconSize}
          strokeWidth={STROKE}
          color={disliked ? DISLIKE : WHITE}
          fill={dislikeFill}
        />
      </Pressable>

      {onToggleSave ? (
        <Pressable
          testID="card-action-save"
          onPress={onToggleSave}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityState={{ selected: saved }}
          accessibilityLabel={t(saved ? 'savedSuggestions.removeAction' : 'savedSuggestions.saveAction')}
        >
          <Bookmark
            size={iconSize}
            strokeWidth={STROKE}
            color={saved ? SAVE_ACCENT : WHITE}
            fill={saved ? SAVE_ACCENT : 'none'}
          />
        </Pressable>
      ) : null}

      {onTrack && !onOverflow ? (
        <Pressable
          testID="card-action-track"
          onPress={onTrack}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityState={{ selected: tracked }}
          accessibilityLabel={t(tracked ? 'trackedStories.untrackAction' : 'trackedStories.trackAction')}
        >
          {/* Crosshair has no enclosed area worth filling, so tracked state is
              carried by COLOUR plus `accessibilityState` plus a changed label —
              never by colour alone. */}
          <Crosshair
            size={iconSize}
            strokeWidth={STROKE}
            color={tracked ? SAVE_ACCENT : WHITE}
            fill="none"
          />
        </Pressable>
      ) : null}

      {onFactCheck && !onOverflow ? (
        <Pressable
          testID="card-action-fact-check"
          // DISABLED ONCE A CHECK EXISTS. A check is cached against the article
          // and shared, so asking again cannot produce a different answer — the
          // second tap would be a no-op that looks like an action. Disabling
          // says "this is already done" instead of quietly doing nothing.
          //
          // `pending` stays TAPPABLE: the panel is already showing progress, and
          // a re-tap there is idempotent (the server returns the same row), so
          // it costs nothing and lets a reader who missed the toast confirm
          // their request landed.
          onPress={factCheckState === 'done' ? undefined : onFactCheck}
          disabled={factCheckState === 'done'}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityState={{
            selected: factCheckState !== 'none',
            disabled: factCheckState === 'done',
          }}
          accessibilityLabel={t(
            factCheckState === 'done'
              ? 'factCheck.actionA11yDone'
              : factCheckState === 'pending'
                ? 'factCheck.actionA11yPending'
                : 'factCheck.actionA11y',
          )}
        >
          {/* ONE SHAPE IN EVERY STATE, colour carries the rest. This used to be
              a single tick that became a double tick once answered; the double
              tick read as "sent/delivered" rather than as "there is a finding
              here", and it changed the affordance's silhouette for something
              that is not a different action. Muted grey is the disabled state,
              and it is the same glyph as the fact-check block it opens. */}
          <SearchCheck
            size={iconSize}
            strokeWidth={STROKE}
            color={
              factCheckState === 'done'
                ? MUTED
                : factCheckState === 'pending'
                  ? SAVE_ACCENT
                  : WHITE
            }
            fill="none"
          />
        </Pressable>
      ) : null}

      {onShare ? (
        <Pressable
          testID="card-action-share"
          onPress={onShare}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityLabel={t('articleDetail.share')}
        >
          {/* M13: one share glyph per platform, the one the system share
              sheet itself uses: the box-and-arrow on iOS, three nodes on
              Android. */}
          {Platform.OS === 'ios' ? (
            <Share size={iconSize} strokeWidth={STROKE} color={WHITE} fill="none" />
          ) : (
            <Share2 size={iconSize} strokeWidth={STROKE} color={WHITE} fill="none" />
          )}
        </Pressable>
      ) : null}

      {onOverflow ? (
        <Pressable
          testID="card-action-more"
          onPress={onOverflow}
          hitSlop={hitSlop}
          accessibilityRole="button"
          accessibilityLabel={t('articleMenu.openA11y')}
        >
          <Ellipsis size={iconSize} strokeWidth={STROKE} color={WHITE} />
        </Pressable>
      ) : null}
    </HStack>
  );
};

export default CardActionBar;
