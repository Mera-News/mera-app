import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The "subscribe at this publisher" affordance, in the two densities the
 * three surfaces need.
 *
 * WHAT THIS IS NOT: Mera's own paid plan. The reader is subscribing to a
 * PUBLISHER, with their own money, on the publisher's own site. That is why
 * every string here names the publisher, why the label is never a bare
 * "Subscribe", and why the external-link icon and the "opens their own site"
 * line are not decoration. Anything that makes this read like the in-app
 * plan is a bug, not a style preference.
 *
 * WHY ONE COMPONENT RATHER THAN THREE LOCAL COPIES: the friction it removes
 * is not layout, it is the accessibility and copy contract. Three copies
 * drift on which string is the label and which is the hint, and a screen
 * reader then announces "Subscribe" with no publisher and no warning that
 * the app is about to be left.
 *
 * NO REFERRER OF ITS OWN. The URL is built once, by `buildSubscriptionUrl`,
 * which appends `utm_source` and `utm_medium=subscription` and nothing else.
 * A per-surface parameter would let the destination distinguish "came from
 * the history screen" from "came from Sources", which is referral
 * attribution, which the product states on its own metrics page that it does
 * not measure, by design. Do not add one.
 *
 * `testID` is REQUIRED and has no default. The inline variant renders once
 * per row in two different lists, and a shared id is worse than none: a query
 * returns the first match, so an assertion passes while testing the wrong
 * publisher's button.
 */
interface Props {
  readonly publisherName: string;
  /**
   * `card` is the publication-history block: a real button, the "opens their
   * own site" line, and the secondary "I subscribe to this" path.
   * `inline` is one line inside a publisher row, where the row already names
   * the publisher and owns its own tap target. It carries no secondary
   * action: a list row is not the place to write durable state.
   */
  readonly variant: 'card' | 'inline';
  readonly onOpen: () => void;
  /** Omit on `inline`. Required in practice for `card`. */
  readonly onAlready?: () => void;
  readonly disabled?: boolean;
  readonly testID: string;
}

const SubscribeAction: React.FC<Props> = ({
  publisherName,
  variant,
  onOpen,
  onAlready,
  disabled = false,
  testID,
}) => {
  const { t } = useTranslation();
  // TEMPORARY, remove in this wave: `subscriptions.subscribeAt` and
  // `subscriptions.opensPublisherSite` ship in
  // `lib/locales/_subscribe-links-fragments.json` and are not spliced yet.
  // i18n keys are typed off `en.json` with no codegen step, so a typed `t()`
  // on either one does not compile until the splice lands. Convert both call
  // sites below to `t()` the moment it does. `subscriptions.iSubscribe`
  // already exists in all 20 dictionaries and is typed, so it uses `t()`.
  const tAny = t as unknown as (key: string, opts?: object) => string;

  const label = tAny('subscriptions.subscribeAt', { publisher: publisherName });
  const hint = tAny('subscriptions.opensPublisherSite', { publisher: publisherName });

  if (variant === 'inline') {
    return (
      <Pressable
        testID={testID}
        onPress={onOpen}
        disabled={disabled}
        // `link`, not `button`: this leaves the app. The hint says where to.
        accessibilityRole="link"
        accessibilityLabel={label}
        accessibilityHint={hint}
        hitSlop={8}
        className="py-1"
      >
        <HStack space="xs" className="items-center">
          <Text size="xs" className="text-gray-300" numberOfLines={1}>
            {label}
          </Text>
          <MaterialIcons name="open-in-new" size={13} color="#d1d5db" />
        </HStack>
      </Pressable>
    );
  }

  return (
    <VStack space="xs">
      <Button
        testID={testID}
        variant="outline"
        action="secondary"
        onPress={onOpen}
        isDisabled={disabled}
        accessibilityRole="link"
        accessibilityLabel={label}
        accessibilityHint={hint}
        className="w-full"
      >
        <HStack space="sm" className="items-center">
          <ButtonText numberOfLines={1}>{label}</ButtonText>
          <MaterialIcons name="open-in-new" size={15} color="#ffffff" />
        </HStack>
      </Button>

      {/* Visible as well as announced: the button label alone does not say
          that the app is about to be handed over to somebody else's site,
          and an accessibility hint is not readable by everyone. */}
      <Text size="xs" className="text-gray-500">
        {hint}
      </Text>

      {onAlready ? (
        <Pressable
          testID={`${testID}-already`}
          onPress={onAlready}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t('subscriptions.iSubscribe')}
          hitSlop={8}
          className="pt-1"
        >
          <Text size="sm" className="text-gray-300 underline">
            {t('subscriptions.iSubscribe')}
          </Text>
        </Pressable>
      ) : null}
    </VStack>
  );
};

export default SubscribeAction;
